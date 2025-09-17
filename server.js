const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// =============================================================================
// CONFIGURATION
// =============================================================================

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Twilio configuration
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: 'Too many login attempts from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Verify user still exists and is active
    const userResult = await pool.query(
      'SELECT id, email, status FROM users WHERE id = $1 AND status = $2',
      [decoded.userId, 'active']
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: decoded.userId,
      email: decoded.email
    };

    // Log security event
    await logSecurityEvent(req.user.id, 'api_access', 'Authenticated API access', 'info', req);
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    
    // Log security event for failed authentication
    await logSecurityEvent(null, 'auth_failure', 'Failed token verification', 'warning', req);
    
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

const logSecurityEvent = async (userId, eventType, description, severity, req) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    
    await pool.query(
      `INSERT INTO security_events (user_id, event_type, description, severity, ip_address, user_agent, request_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, eventType, description, severity, ip, userAgent, req.path]
    );
  } catch (error) {
    console.error('Failed to log security event:', error);
  }
};

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePassword = (password) => {
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/\d/.test(password)) return 'Password must contain at least one number';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>?]/.test(password)) return 'Password must contain at least one special character';
  return null;
};

const formatPhoneNumber = (phoneNumber) => {
  // Remove all non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Add country code if not present
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  }
  
  return `+${cleaned}`;
};

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await pool.query('SELECT NOW()');
    
    // Test Twilio connection (optional)
    let twilioStatus = 'unknown';
    try {
      await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      twilioStatus = 'connected';
    } catch (twilioError) {
      twilioStatus = 'disconnected';
    }

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      twilio: twilioStatus,
      version: '1.0.0'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// =============================================================================
// API TEST ENDPOINTS
// =============================================================================

// Twilio test endpoint for frontend API testing
app.get('/api/twilio/test', async (req, res) => {
  try {
    // Check if Twilio is configured
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.status(500).json({
        success: false,
        error: 'Twilio not configured'
      });
    }

    // Test Twilio connection
    let twilioStatus = 'disconnected';
    try {
      await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      twilioStatus = 'connected';
    } catch (twilioError) {
      console.error('Twilio test error:', twilioError);
      return res.status(500).json({
        success: false,
        error: 'Twilio connection failed'
      });
    }

    res.json({
      success: true,
      message: 'Twilio integration ready',
      timestamp: new Date().toISOString(),
      configured: true,
      status: twilioStatus
    });

  } catch (error) {
    console.error('Twilio test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Twilio test failed'
    });
  }
});

// =============================================================================
// AUTHENTICATION ROUTES
// =============================================================================

// Register new user
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName } = req.body;

  try {
    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      await logSecurityEvent(null, 'registration_attempt', 'Attempted registration with existing email', 'warning', req);
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, is_active, email_verified)
       VALUES ($1, $2, $3, $4, true, false)
       RETURNING id, email, first_name, last_name, created_at`,
      [email.toLowerCase(), passwordHash, firstName, lastName]
    );

    const user = userResult.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    await logSecurityEvent(user.id, 'user_registration', 'New user registered', 'info', req);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        createdAt: user.created_at
      },
      token,
      expiresIn: JWT_EXPIRES_IN
    });

  } catch (error) {
    console.error('Registration error:', error);
    await logSecurityEvent(null, 'registration_error', `Registration failed: ${error.message}`, 'critical', req);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Get user
    const userResult = await pool.query(
      'SELECT id, email, password_hash, is_active FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      await logSecurityEvent(null, 'login_attempt', 'Login attempt with non-existent email', 'warning', req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Check if account is active
    if (!user.is_active) {
      await logSecurityEvent(user.id, 'login_blocked', 'Login attempt on inactive account', 'warning', req);
      return res.status(401).json({ error: 'Account not active' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      await logSecurityEvent(user.id, 'login_failure', 'Failed login attempt', 'warning', req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    await logSecurityEvent(user.id, 'login_success', 'Successful login', 'info', req);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email
      },
      token,
      expiresIn: JWT_EXPIRES_IN
    });

  } catch (error) {
    console.error('Login error:', error);
    await logSecurityEvent(null, 'login_error', `Login failed: ${error.message}`, 'critical', req);
    res.status(500).json({ error: 'Login failed' });
  }
});

// =============================================================================
// USER MANAGEMENT ROUTES
// =============================================================================

// Get current user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.email_verified,
              u.created_at, u.last_login,
              COUNT(pn.id) as phone_numbers_count
       FROM users u
       LEFT JOIN phone_numbers pn ON u.id = pn.user_id AND pn.status = 'active'
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        isActive: user.is_active,
        emailVerified: user.email_verified,
        createdAt: user.created_at,
        lastLogin: user.last_login,
        phoneNumbersCount: parseInt(user.phone_numbers_count)
      }
    });

  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// =============================================================================
// PHONE NUMBER MANAGEMENT ROUTES
// =============================================================================

// Search available phone numbers
app.get('/api/numbers/search', authenticateToken, async (req, res) => {
  try {
    const { areaCode, country = 'US' } = req.query;

    if (!areaCode || areaCode.length !== 3) {
      return res.status(400).json({ error: 'Valid 3-digit area code required' });
    }

    // Search for available numbers via Twilio
    const availableNumbers = await twilioClient.availablePhoneNumbers(country)
      .local
      .list({ areaCode: areaCode, limit: 20 });

    const numbers = availableNumbers.map(number => ({
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      locality: number.locality,
      region: number.region,
      capabilities: number.capabilities
    }));

    await logSecurityEvent(req.user.id, 'number_search', `Searched for numbers in area code ${areaCode}`, 'info', req);

    res.json({
      areaCode,
      country,
      availableNumbers: numbers
    });

  } catch (error) {
    console.error('Number search error:', error);
    res.status(500).json({ error: 'Failed to search for phone numbers' });
  }
});

// Purchase phone number
app.post('/api/numbers/purchase', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { phoneNumber, nickname } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Purchase number from Twilio
    const twilioNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${process.env.BACKEND_ROOT}/api/webhooks/twilio/voice`,
      smsUrl: `${process.env.BACKEND_ROOT}/api/webhooks/twilio/sms`,
      voiceMethod: 'POST',
      smsMethod: 'POST'
    });

    // Store in database
    const result = await client.query(
      `INSERT INTO phone_numbers (
        user_id, phone_number, formatted_number, country_code, area_code,
        twilio_sid, nickname, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING id, phone_number, formatted_number, nickname, purchased_at`,
      [
        req.user.id,
        twilioNumber.phoneNumber,
        twilioNumber.friendlyName,
        'US',
        phoneNumber.substring(2, 5), // Extract area code
        twilioNumber.sid,
        nickname || null
      ]
    );

    await client.query('COMMIT');

    const newNumber = result.rows[0];

    await logSecurityEvent(req.user.id, 'number_purchase', `Purchased phone number ${phoneNumber}`, 'info', req);

    res.status(201).json({
      message: 'Phone number purchased successfully',
      phoneNumber: {
        id: newNumber.id,
        phoneNumber: newNumber.phone_number,
        formattedNumber: newNumber.formatted_number,
        nickname: newNumber.nickname,
        purchasedAt: newNumber.purchased_at
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Number purchase error:', error);
    res.status(500).json({ error: 'Failed to purchase phone number' });
  } finally {
    client.release();
  }
});

// Get user's phone numbers
app.get('/api/numbers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone_number, formatted_number, nickname, status, 
              total_calls_made, total_calls_received, total_sms_sent, total_sms_received,
              purchased_at, burned_at
       FROM phone_numbers 
       WHERE user_id = $1 
       ORDER BY purchased_at DESC`,
      [req.user.id]
    );

    res.json({
      phoneNumbers: result.rows.map(row => ({
        id: row.id,
        phoneNumber: row.phone_number,
        formattedNumber: row.formatted_number,
        nickname: row.nickname,
        status: row.status,
        usage: {
          callsMade: row.total_calls_made,
          callsReceived: row.total_calls_received,
          smsSent: row.total_sms_sent,
          smsReceived: row.total_sms_received
        },
        purchasedAt: row.purchased_at,
        burnedAt: row.burned_at
      }))
    });

  } catch (error) {
    console.error('Numbers fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch phone numbers' });
  }
});

// Burn (delete) phone number
app.delete('/api/numbers/:numberId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { numberId } = req.params;

    // Get number details
    const numberResult = await client.query(
      'SELECT id, phone_number, twilio_sid FROM phone_numbers WHERE id = $1 AND user_id = $2 AND status = $3',
      [numberId, req.user.id, 'active']
    );

    if (numberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const number = numberResult.rows[0];

    // Release number from Twilio
    if (number.twilio_sid) {
      try {
        await twilioClient.incomingPhoneNumbers(number.twilio_sid).remove();
      } catch (twilioError) {
        console.error('Twilio release error:', twilioError);
        // Continue with database update even if Twilio fails
      }
    }

    // Update number status in database
    await client.query(
      'UPDATE phone_numbers SET status = $1, burned_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['burned', numberId]
    );

    await client.query('COMMIT');

    await logSecurityEvent(req.user.id, 'number_burned', `Burned phone number ${number.phone_number}`, 'info', req);

    res.json({ message: 'Phone number burned successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Number burn error:', error);
    res.status(500).json({ error: 'Failed to burn phone number' });
  } finally {
    client.release();
  }
});

// =============================================================================
// MESSAGING ROUTES
// =============================================================================

// Send SMS message
app.post('/api/messages/send', authenticateToken, async (req, res) => {
  try {
    const { fromNumberId, toNumber, messageBody } = req.body;

    if (!fromNumberId || !toNumber || !messageBody) {
      return res.status(400).json({ error: 'From number, to number, and message body are required' });
    }

    // Get user's phone number
    const numberResult = await pool.query(
      'SELECT phone_number FROM phone_numbers WHERE id = $1 AND user_id = $2 AND status = $3',
      [fromNumberId, req.user.id, 'active']
    );

    if (numberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    const fromNumber = numberResult.rows[0].phone_number;
    const formattedToNumber = formatPhoneNumber(toNumber);

    // Send message via Twilio
    const message = await twilioClient.messages.create({
      body: messageBody,
      from: fromNumber,
      to: formattedToNumber
    });

    // Store in database
    const result = await pool.query(
      `INSERT INTO messages (
        user_id, phone_number_id, from_number, to_number, body, 
        direction, twilio_sid, sent_at
       ) VALUES ($1, $2, $3, $4, $5, 'outbound', $6, CURRENT_TIMESTAMP)
       RETURNING id, created_at`,
      [req.user.id, fromNumberId, fromNumber, formattedToNumber, messageBody, message.sid]
    );

    res.status(201).json({
      message: 'Message sent successfully',
      messageId: result.rows[0].id,
      twilioSid: message.sid,
      sentAt: result.rows[0].created_at
    });

  } catch (error) {
    console.error('Message send error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get messages for a phone number
app.get('/api/messages/:numberId', authenticateToken, async (req, res) => {
  try {
    const { numberId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    // Verify number ownership
    const numberResult = await pool.query(
      'SELECT id FROM phone_numbers WHERE id = $1 AND user_id = $2',
      [numberId, req.user.id]
    );

    if (numberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    // Get messages
    const result = await pool.query(
      `SELECT id, from_number, to_number, body, direction,
              sent_at, delivered_at, created_at
       FROM messages 
       WHERE phone_number_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [numberId, limit, offset]
    );

    res.json({
      messages: result.rows
    });

  } catch (error) {
    console.error('Messages fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// =============================================================================
// TWILIO WEBHOOKS
// =============================================================================

// Incoming SMS webhook
app.post('/api/webhooks/twilio/sms', async (req, res) => {
  try {
    const { From, To, Body, MessageSid, SmsStatus } = req.body;

    // Find the phone number
    const numberResult = await pool.query(
      'SELECT id, user_id FROM phone_numbers WHERE phone_number = $1 AND status = $2',
      [To, 'active']
    );

    if (numberResult.rows.length === 0) {
      console.error('Received SMS for unknown number:', To);
      return res.status(404).send('Number not found');
    }

    const { id: phoneNumberId, user_id: userId } = numberResult.rows[0];

    // Store incoming message
    await pool.query(
      `INSERT INTO messages (
        user_id, phone_number_id, from_number, to_number, body,
        direction, twilio_sid, sent_at
       ) VALUES ($1, $2, $3, $4, $5, 'inbound', $6, CURRENT_TIMESTAMP)`,
      [userId, phoneNumberId, From, To, Body, MessageSid]
    );

    // Update phone number usage stats
    await pool.query(
      'UPDATE phone_numbers SET total_sms_received = total_sms_received + 1 WHERE id = $1',
      [phoneNumberId]
    );

    res.status(200).send('OK');

  } catch (error) {
    console.error('SMS webhook error:', error);
    res.status(500).send('Error processing SMS');
  }
});

// Incoming voice webhook
app.post('/api/webhooks/twilio/voice', async (req, res) => {
  try {
    const { From, To, CallSid, CallStatus } = req.body;

    // Find the phone number
    const numberResult = await pool.query(
      'SELECT id, user_id FROM phone_numbers WHERE phone_number = $1 AND status = $2',
      [To, 'active']
    );

    if (numberResult.rows.length === 0) {
      console.error('Received call for unknown number:', To);
      return res.status(404).send('Number not found');
    }

    const { id: phoneNumberId, user_id: userId } = numberResult.rows[0];

    // Store incoming call
    await pool.query(
      `INSERT INTO calls (
        user_id, phone_number_id, from_number, to_number, direction,
        twilio_sid, status, started_at
       ) VALUES ($1, $2, $3, $4, 'inbound', $5, $6, CURRENT_TIMESTAMP)`,
      [userId, phoneNumberId, From, To, CallSid, CallStatus]
    );

    // Generate TwiML response (simple voicemail for now)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">You have reached a Switchline number. Please leave a message after the tone.</Say>
      <Record timeout="30" maxLength="300" />
      <Say voice="alice">Thank you for your message. Goodbye.</Say>
    </Response>`;

    res.type('text/xml');
    res.send(twiml);

  } catch (error) {
    console.error('Voice webhook error:', error);
    res.status(500).send('Error processing call');
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

const server = app.listen(PORT, () => {
  console.log(`Switchline API server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    pool.end();
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    pool.end();
  });
});

module.exports = app;

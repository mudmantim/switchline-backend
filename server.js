const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Stripe = require('stripe');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Initialize services
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripeClient = Stripe(process.env.STRIPE_SECRET_KEY);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middlewareconst express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const stripe = require('stripe');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();

// Environment Configuration
const CONFIG = {
    PORT: process.env.PORT || 3001,
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // Database (In production, use actual database)
    JWT_SECRET: process.env.JWT_SECRET || 'switchline-super-secret-key-change-in-production',
    
    // Twilio Configuration
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || 'your_twilio_account_sid',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || 'your_twilio_auth_token',
    
    // Stripe Configuration
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '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',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    
    // Frontend URLs
    FRONTEND_URLS: [
        'https://switchline.app',
        'https://www.switchline.app',
        'http://localhost:3000',
        'http://localhost:8080',
        'http://127.0.0.1:3000'
    ]
};

// Initialize Services
const twilioClient = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
const stripeClient = stripe(CONFIG.STRIPE_SECRET_KEY);

// In-memory storage (Replace with actual database in production)
const users = new Map();
const userNumbers = new Map();
const userSessions = new Map();

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { success: false, message: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 auth attempts per windowMs
    message: { success: false, message: 'Too many authentication attempts, please try again later.' }
});

// Middleware
app.use(limiter);
app.use(cors({
    origin: CONFIG.FRONTEND_URLS,
    credentials: true,
    optionsSuccessStatus: 200
}));

// Raw body for Stripe webhooks
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
    next();
});

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access token required' });
    }

    jwt.verify(token, CONFIG.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// Utility Functions
function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function generateToken(user) {
    return jwt.sign(
        { userId: user.id, email: user.email },
        CONFIG.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function validatePhoneNumber(phoneNumber) {
    const re = /^\+1\d{10}$/;
    return re.test(phoneNumber);
}

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'Switchline Backend API',
        version: '2.1.0',
        environment: CONFIG.NODE_ENV,
        timestamp: new Date().toISOString(),
        features: [
            'User Authentication',
            'Stripe Payment Integration',
            'Twilio Phone Services',
            'Phone Number Management',
            'Secure Communication'
        ],
        endpoints: {
            auth: '/api/auth/*',
            twilio: '/api/twilio/*',
            stripe: '/api/stripe/*',
            user: '/api/user/*'
        },
        contact: 'admin@switchline.app'
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// AUTHENTICATION ROUTES

// User Registration
app.post('/api/auth/signup', authLimiter, async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and password are required'
            });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long'
            });
        }

        // Check if user already exists
        for (let [id, user] of users) {
            if (user.email === email) {
                return res.status(400).json({
                    success: false,
                    message: 'User with this email already exists'
                });
            }
        }

        // Create user
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = generateUserId();
        
        const newUser = {
            id: userId,
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            createdAt: new Date().toISOString(),
            isActive: true
        };

        users.set(userId, newUser);
        userNumbers.set(userId, []);

        // Generate token
        const token = generateToken(newUser);

        // User object without password
        const userResponse = {
            id: newUser.id,
            name: newUser.name,
            email: newUser.email,
            createdAt: newUser.createdAt
        };

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            user: userResponse,
            token: token
        });

        console.log(`New user registered: ${email}`);

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during signup'
        });
    }
});

// User Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // Find user
        let foundUser = null;
        for (let [id, user] of users) {
            if (user.email === email.toLowerCase().trim()) {
                foundUser = user;
                break;
            }
        }

        if (!foundUser) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, foundUser.password);
        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Generate token
        const token = generateToken(foundUser);

        // User object without password
        const userResponse = {
            id: foundUser.id,
            name: foundUser.name,
            email: foundUser.email,
            createdAt: foundUser.createdAt
        };

        res.json({
            success: true,
            message: 'Login successful',
            user: userResponse,
            token: token
        });

        console.log(`User logged in: ${email}`);

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during login'
        });
    }
});

// TWILIO ROUTES

// Test Twilio Connection
app.get('/api/twilio/test', async (req, res) => {
    try {
        const account = await twilioClient.api.accounts(CONFIG.TWILIO_ACCOUNT_SID).fetch();
        res.json({
            success: true,
            message: 'Twilio connection successful',
            accountStatus: account.status,
            accountSid: account.sid
        });
    } catch (error) {
        console.error('Twilio test error:', error);
        res.status(500).json({
            success: false,
            message: 'Twilio connection failed',
            error: error.message
        });
    }
});

// Search Available Phone Numbers
app.get('/api/twilio/available-numbers', authenticateToken, async (req, res) => {
    try {
        const { areaCode, contains, country = 'US' } = req.query;

        if (!areaCode && !contains) {
            return res.status(400).json({
                success: false,
                message: 'Area code or contains parameter is required'
            });
        }

        const searchOptions = {
            areaCode: areaCode,
            contains: contains,
            limit: 20
        };

        const numbers = await twilioClient.availablePhoneNumbers(country)
            .local
            .list(searchOptions);

        const availableNumbers = numbers.map(number => ({
            phoneNumber: number.phoneNumber,
            friendlyName: number.friendlyName,
            locality: number.locality,
            region: number.region,
            capabilities: number.capabilities
        }));

        res.json({
            success: true,
            numbers: availableNumbers,
            count: availableNumbers.length
        });

    } catch (error) {
        console.error('Available numbers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch available numbers',
            error: error.message
        });
    }
});

// Purchase Phone Number
app.post('/api/twilio/purchase-number', authenticateToken, async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        const userId = req.user.userId;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        if (!validatePhoneNumber(phoneNumber)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid phone number format'
            });
        }

        // Purchase the number from Twilio
        const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
            phoneNumber: phoneNumber,
            voiceUrl: `${req.protocol}://${req.get('host')}/api/twilio/voice-webhook`,
            smsUrl: `${req.protocol}://${req.get('host')}/api/twilio/sms-webhook`
        });

        // Add to user's numbers
        const userNumbersList = userNumbers.get(userId) || [];
        const numberData = {
            phoneNumber: phoneNumber,
            sid: purchasedNumber.sid,
            purchaseDate: new Date().toISOString(),
            status: 'active'
        };

        userNumbersList.push(numberData);
        userNumbers.set(userId, userNumbersList);

        res.json({
            success: true,
            message: 'Phone number purchased successfully',
            number: numberData
        });

        console.log(`Number purchased: ${phoneNumber} by user ${userId}`);

    } catch (error) {
        console.error('Purchase number error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to purchase phone number',
            error: error.message
        });
    }
});

// Make Phone Call
app.post('/api/twilio/make-call', authenticateToken, async (req, res) => {
    try {
        const { from, to } = req.body;
        const userId = req.user.userId;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: 'From and to numbers are required'
            });
        }

        // Verify user owns the from number
        const userNumbersList = userNumbers.get(userId) || [];
        const ownedNumber = userNumbersList.find(num => num.phoneNumber === from);

        if (!ownedNumber) {
            return res.status(403).json({
                success: false,
                message: 'You do not own the from number'
            });
        }

        // Make the call
        const call = await twilioClient.calls.create({
            from: from,
            to: to,
            url: `${req.protocol}://${req.get('host')}/api/twilio/voice-webhook`
        });

        res.json({
            success: true,
            message: 'Call initiated successfully',
            callSid: call.sid,
            status: call.status
        });

        console.log(`Call initiated: ${from} -> ${to} by user ${userId}`);

    } catch (error) {
        console.error('Make call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to make call',
            error: error.message
        });
    }
});

// Voice Webhook
app.post('/api/twilio/voice-webhook', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    
    twiml.say({
        voice: 'alice'
    }, 'Hello! This is your Switchline number. Please leave a message after the beep.');
    
    twiml.record({
        timeout: 30,
        maxLength: 300,
        action: '/api/twilio/recording-webhook'
    });

    res.type('text/xml');
    res.send(twiml.toString());
});

// SMS Webhook
app.post('/api/twilio/sms-webhook', (req, res) => {
    const twiml = new twilio.twiml.MessagingResponse();
    
    const { From, To, Body } = req.body;
    
    // Log the message (in production, store in database)
    console.log(`SMS received: ${From} -> ${To}: ${Body}`);
    
    // Auto-reply
    twiml.message('Thank you for your message! This is an automated response from Switchline.');

    res.type('text/xml');
    res.send(twiml.toString());
});

// STRIPE ROUTES

// Test Stripe Connection
app.get('/api/stripe/test', async (req, res) => {
    try {
        const account = await stripeClient.accounts.retrieve();
        res.json({
            success: true,
            message: 'Stripe connection successful',
            accountId: account.id,
            chargesEnabled: account.charges_enabled
        });
    } catch (error) {
        console.error('Stripe test error:', error);
        res.status(500).json({
            success: false,
            message: 'Stripe connection failed',
            error: error.message
        });
    }
});

// Create Checkout Session
app.post('/api/stripe/create-checkout', authenticateToken, async (req, res) => {
    try {
        const { phoneNumber, priceId, successUrl, cancelUrl } = req.body;
        const userId = req.user.userId;

        if (!phoneNumber || !priceId) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and price ID are required'
            });
        }

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: successUrl || `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl || `${req.protocol}://${req.get('host')}/cancel`,
            metadata: {
                userId: userId,
                phoneNumber: phoneNumber
            }
        });

        res.json({
            success: true,
            sessionId: session.id,
            url: session.url
        });

    } catch (error) {
        console.error('Stripe checkout error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create checkout session',
            error: error.message
        });
    }
});

// Stripe Webhook
app.post('/api/stripe/webhook', (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripeClient.webhooks.constructEvent(req.body, sig, CONFIG.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('Payment successful for session:', session.id);
            
            // Here you would typically:
            // 1. Purchase the phone number via Twilio
            // 2. Associate it with the user
            // 3. Send confirmation email
            
            break;

        case 'invoice.payment_failed':
            console.log('Payment failed for invoice:', event.data.object.id);
            // Handle failed payment
            break;

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
});

// USER ROUTES

// Get User Dashboard Data
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const numbers = userNumbers.get(userId) || [];

        // Mock stats (in production, calculate from database)
        const stats = {
            totalCalls: Math.floor(Math.random() * 100),
            totalMessages: Math.floor(Math.random() * 200),
            activeNumbers: numbers.length
        };

        res.json({
            success: true,
            numbers: numbers,
            stats: stats
        });

    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard data',
            error: error.message
        });
    }
});

// Get User Profile
app.get('/api/user/profile', authenticateToken, (req, res) => {
    try {
        const userId = req.user.userId;
        const user = users.get(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const userProfile = {
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: user.createdAt
        };

        res.json({
            success: true,
            user: userProfile
        });

    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load user profile',
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal server error',
        ...(CONFIG.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

// Start server
app.listen(CONFIG.PORT, () => {
    console.log(`
🚀 Switchline Backend Server Started
📍 Environment: ${CONFIG.NODE_ENV}
🌐 Port: ${CONFIG.PORT}
🔗 URL: http://localhost:${CONFIG.PORT}
📧 Twilio configured: ${CONFIG.TWILIO_ACCOUNT_SID ? '✅' : '❌'}
💳 Stripe configured: ${CONFIG.STRIPE_SECRET_KEY ? '✅' : '❌'}
🔐 JWT Secret: ${CONFIG.JWT_SECRET ? '✅' : '❌'}

API Endpoints:
- GET  / (Health check)
- POST /api/auth/signup
- POST /api/auth/login
- GET  /api/twilio/available-numbers
- POST /api/twilio/purchase-number
- POST /api/twilio/make-call
- POST /api/stripe/create-checkout
- GET  /api/user/dashboard

🎯 Ready to serve Switchline app requests!
    `);
});

module.exports = app;

app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Utility function for Stripe customer management
async function getOrCreateStripeCustomer(userId, email, name) {
  try {
    const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
    
    if (userResult.rows[0]?.stripe_customer_id) {
      return userResult.rows[0].stripe_customer_id;
    }

    const customer = await stripeClient.customers.create({
      email: email,
      name: name,
      metadata: { userId: userId }
    });

    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, userId]
    );

    return customer.id;
  } catch (error) {
    console.error('Error managing Stripe customer:', error);
    throw error;
  }
}

// ============================================================================
// HEALTH CHECK AND TESTING ENDPOINTS
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Switchline Backend',
    version: '1.0.0'
  });
});

app.get('/test-basic', (req, res) => {
  res.json({
    message: 'Server is working!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/twilio/test', async (req, res) => {
  try {
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({
      success: true,
      message: 'Twilio connection successful',
      accountSid: account.sid,
      accountStatus: account.status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Twilio connection failed',
      details: error.message
    });
  }
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;

    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, salt, first_name, last_name, status) 
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id, email, first_name, last_name`,
      [email, passwordHash, salt, firstName, lastName]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, first_name, last_name, status FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is not active' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================================
// PHONE NUMBER ENDPOINTS
// ============================================================================

app.get('/api/numbers/search/:areaCode', async (req, res) => {
  try {
    const { areaCode } = req.params;

    if (!areaCode || areaCode.length !== 3) {
      return res.status(400).json({ 
        success: false,
        error: 'Valid 3-digit area code required' 
      });
    }

    const availableNumbers = await twilioClient.availablePhoneNumbers('US')
      .local
      .list({
        areaCode: areaCode,
        limit: 10
      });

    const formattedNumbers = availableNumbers.map(number => ({
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      locality: number.locality,
      region: number.region,
      capabilities: number.capabilities
    }));

    res.json({
      success: true,
      numbers: formattedNumbers
    });

  } catch (error) {
    console.error('Number search error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to search for numbers',
      details: error.message
    });
  }
});

app.post('/api/numbers/purchase', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Check user's plan limits
    const userResult = await pool.query(`
      SELECT u.phone_numbers_limit, COUNT(pn.id) as current_count
      FROM users u
      LEFT JOIN phone_numbers pn ON u.id = pn.user_id AND pn.status != 'burned'
      WHERE u.id = $1
      GROUP BY u.id, u.phone_numbers_limit
    `, [req.user.id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { phone_numbers_limit, current_count } = userResult.rows[0];
    
    if (current_count >= phone_numbers_limit) {
      return res.status(400).json({ 
        error: 'Phone number limit reached for your plan',
        limit: phone_numbers_limit,
        current: current_count
      });
    }

    // Purchase number through Twilio
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${process.env.BASE_URL}/webhook/twilio/voice`,
      smsUrl: `${process.env.BASE_URL}/webhook/twilio/sms`
    });

    // Store in database
    const result = await pool.query(`
      INSERT INTO phone_numbers (user_id, phone_number, twilio_sid, status, purchased_at)
      VALUES ($1, $2, $3, 'active', CURRENT_TIMESTAMP)
      RETURNING id, phone_number, status, purchased_at
    `, [req.user.id, phoneNumber, purchasedNumber.sid]);

    res.json({
      success: true,
      number: result.rows[0]
    });

  } catch (error) {
    console.error('Number purchase error:', error);
    res.status(500).json({ error: 'Failed to purchase number' });
  }
});

app.get('/api/numbers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, phone_number, status, purchased_at, burned_at
      FROM phone_numbers 
      WHERE user_id = $1 AND status != 'burned'
      ORDER BY purchased_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      numbers: result.rows
    });

  } catch (error) {
    console.error('Get numbers error:', error);
    res.status(500).json({ error: 'Failed to fetch numbers' });
  }
});

app.delete('/api/numbers/:id/burn', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const numberResult = await pool.query(
      'SELECT phone_number, twilio_sid FROM phone_numbers WHERE id = $1 AND user_id = $2 AND status = $3',
      [id, req.user.id, 'active']
    );

    if (numberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Number not found or already burned' });
    }

    const { phone_number, twilio_sid } = numberResult.rows[0];

    // Release number from Twilio
    await twilioClient.incomingPhoneNumbers(twilio_sid).remove();

    // Update database
    await pool.query(`
      UPDATE phone_numbers 
      SET status = 'burned', burned_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      message: 'Number burned successfully'
    });

  } catch (error) {
    console.error('Burn number error:', error);
    res.status(500).json({ error: 'Failed to burn number' });
  }
});

// ============================================================================
// MESSAGING ENDPOINTS
// ============================================================================

app.post('/api/messages/send', authenticateToken, async (req, res) => {
  try {
    const { to, body, from } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: 'To and body are required' });
    }

    let fromNumber = from;
    if (!fromNumber) {
      const activeNumberResult = await pool.query(`
        SELECT pn.phone_number 
        FROM users u
        JOIN phone_numbers pn ON u.active_phone_number_id = pn.id
        WHERE u.id = $1
      `, [req.user.id]);

      if (activeNumberResult.rows.length === 0) {
        return res.status(400).json({ error: 'No active phone number found' });
      }
      fromNumber = activeNumberResult.rows[0].phone_number;
    }

    const message = await twilioClient.messages.create({
      body: body,
      from: fromNumber,
      to: to
    });

    await pool.query(`
      INSERT INTO messages (user_id, from_number, to_number, body, direction, twilio_sid, status)
      VALUES ($1, $2, $3, $4, 'outbound', $5, $6)
    `, [req.user.id, fromNumber, to, body, message.sid, message.status]);

    res.json({
      success: true,
      messageSid: message.sid,
      status: message.status
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================================
// CALLING ENDPOINTS
// ============================================================================

app.post('/api/calls/make', authenticateToken, async (req, res) => {
  try {
    const { to, from } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'To number is required' });
    }

    let fromNumber = from;
    if (!fromNumber) {
      const activeNumberResult = await pool.query(`
        SELECT pn.phone_number 
        FROM users u
        JOIN phone_numbers pn ON u.active_phone_number_id = pn.id
        WHERE u.id = $1
      `, [req.user.id]);

      if (activeNumberResult.rows.length === 0) {
        return res.status(400).json({ error: 'No active phone number found' });
      }
      fromNumber = activeNumberResult.rows[0].phone_number;
    }

    const call = await twilioClient.calls.create({
      to: to,
      from: fromNumber,
      url: `${process.env.BASE_URL}/webhook/twilio/voice`
    });

    await pool.query(`
      INSERT INTO calls (user_id, from_number, to_number, direction, twilio_sid, status)
      VALUES ($1, $2, $3, 'outbound', $4, $5)
    `, [req.user.id, fromNumber, to, call.sid, call.status]);

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status
    });

  } catch (error) {
    console.error('Make call error:', error);
    res.status(500).json({ error: 'Failed to make call' });
  }
});

// ============================================================================
// BILLING ENDPOINTS  
// ============================================================================

app.get('/api/billing/subscription', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, sp.name as plan_name, sp.price_cents, sp.phone_numbers_limit, sp.minutes_limit, sp.sms_limit
      FROM users u
      LEFT JOIN subscription_plans sp ON u.subscription_plan_id = sp.id
      WHERE u.id = $1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      subscription: {
        planName: user.plan_name || 'Free',
        price: user.price_cents ? user.price_cents / 100 : 0,
        limits: {
          phoneNumbers: user.phone_numbers_limit || 1,
          minutes: user.minutes_limit || 100,
          sms: user.sms_limit || 50
        }
      },
      stripeCustomerId: user.stripe_customer_id
    });
  } catch (error) {
    console.error('Failed to fetch subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription info' });
  }
});

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

app.post('/webhook/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Hello from Switchline! This call is being handled.');
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/twilio/sms', async (req, res) => {
  try {
    const { From, To, Body, MessageSid } = req.body;

    const userResult = await pool.query(
      'SELECT user_id FROM phone_numbers WHERE phone_number = $1 AND status = $2',
      [To, 'active']
    );

    if (userResult.rows.length > 0) {
      await pool.query(`
        INSERT INTO messages (user_id, from_number, to_number, body, direction, twilio_sid, status)
        VALUES ($1, $2, $3, $4, 'inbound', $5, 'received')
      `, [userResult.rows[0].user_id, From, To, Body, MessageSid]);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('SMS webhook error:', error);
    res.status(500).send('Error');
  }
});

app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        // Update user's subscription in database
        break;
      case 'customer.subscription.deleted':
        // Handle subscription cancellation
        break;
      case 'invoice.payment_succeeded':
        // Handle successful payment
        break;
      case 'invoice.payment_failed':
        // Handle failed payment
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Switchline backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

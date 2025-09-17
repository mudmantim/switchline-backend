const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
db.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err);
  } else {
    console.log('Database: Connected');
    release();
  }
});

// Database setup function
async function setupDatabase() {
  try {
    // First, enable UUID extension
    await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Create users table with UUID primary key
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(50) DEFAULT 'basic',
        credits INTEGER DEFAULT 0,
        status VARCHAR(50) DEFAULT 'active',
        stripe_customer_id VARCHAR(255),
        subscription_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create security_events table with UUID foreign key
    await db.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id),
        event_type VARCHAR(100),
        details TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create phone_numbers table with UUID foreign key
    await db.query(`
      CREATE TABLE IF NOT EXISTS phone_numbers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id),
        phone_number VARCHAR(20) NOT NULL,
        twilio_sid VARCHAR(255),
        area_code VARCHAR(10),
        location VARCHAR(100),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create messages table with UUID foreign keys
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id),
        phone_number_id UUID REFERENCES phone_numbers(id),
        from_number VARCHAR(20),
        to_number VARCHAR(20),
        message_body TEXT,
        direction VARCHAR(20),
        twilio_sid VARCHAR(255),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create test user if it doesn't exist
    const hashedPassword = await bcrypt.hash('test123', 10);
    
    const result = await db.query(`
      INSERT INTO users (email, password, plan, credits, status) 
      VALUES ($1, $2, $3, $4, $5) 
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, ['test@switchline.com', hashedPassword, 'pro', 50, 'active']);

    if (result.rows.length > 0) {
      console.log('Test user created successfully');
    } else {
      console.log('Test user already exists');
    }

    console.log('✅ Database setup complete');
  } catch (error) {
    console.error('❌ Database setup error:', error);
  }
}

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Security event logging
async function logSecurityEvent(userId, eventType, details, req) {
  try {
    await db.query(
      'INSERT INTO security_events (user_id, event_type, details, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [userId, eventType, details, req.ip, req.headers['user-agent']]
    );
  } catch (error) {
    console.error('Failed to log security event:', error);
  }
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Switchline API Server', 
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      await logSecurityEvent(null, 'LOGIN_FAILED', `Failed login attempt for ${email}`, req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      await logSecurityEvent(user.id, 'LOGIN_FAILED', 'Invalid password', req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    await logSecurityEvent(user.id, 'LOGIN_SUCCESS', 'Successful login', req);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        credits: user.credits,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
    const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await db.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, plan, credits, status',
      [email, hashedPassword]
    );

    const user = result.rows[0];

    // Create JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    await logSecurityEvent(user.id, 'REGISTER_SUCCESS', 'Account created', req);

    res.status(201).json({
      token,
      user
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Billing Routes
app.get('/api/billing/plans', (req, res) => {
  const plans = [
    {
      id: 'basic',
      name: 'Basic',
      price: 999,
      currency: 'usd',
      interval: 'month',
      features: [
        '1 Phone Number',
        '100 Messages/Month',
        '50 Minutes/Month',
        'Basic Support'
      ]
    },
    {
      id: 'pro',
      name: 'Pro',
      price: 1999,
      currency: 'usd',
      interval: 'month',
      features: [
        '5 Phone Numbers',
        'Unlimited Messages',
        '500 Minutes/Month',
        'Priority Support',
        'Advanced Features'
      ]
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: 4999,
      currency: 'usd',
      interval: 'month',
      features: [
        'Unlimited Phone Numbers',
        'Unlimited Messages',
        'Unlimited Minutes',
        '24/7 Support',
        'Custom Integrations',
        'Dedicated Manager'
      ]
    }
  ];

  res.json({ plans });
});

app.get('/api/billing/subscription', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT plan, credits, status, stripe_customer_id, subscription_id FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    let subscription = null;
    if (user.subscription_id) {
      try {
        subscription = await stripe.subscriptions.retrieve(user.subscription_id);
      } catch (error) {
        console.error('Error retrieving subscription:', error);
      }
    }

    res.json({
      plan: user.plan,
      credits: user.credits,
      status: user.status,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        current_period_end: subscription.current_period_end,
        current_period_start: subscription.current_period_start
      } : null
    });
  } catch (error) {
    console.error('Billing info error:', error);
    res.status(500).json({ error: 'Failed to retrieve billing information' });
  }
});

app.post('/api/billing/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const { amount, currency = 'usd' } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency,
      metadata: {
        userId: req.user.userId.toString()
      }
    });

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id
    });
  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

app.post('/api/billing/create-subscription', authenticateToken, async (req, res) => {
  try {
    const { plan_id, payment_method } = req.body;

    if (!plan_id || !payment_method) {
      return res.status(400).json({ error: 'Plan ID and payment method are required' });
    }

    // Get or create Stripe customer
    let customer;
    const userResult = await db.query(
      'SELECT stripe_customer_id, email FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows[0].stripe_customer_id) {
      customer = await stripe.customers.retrieve(userResult.rows[0].stripe_customer_id);
    } else {
      customer = await stripe.customers.create({
        email: userResult.rows[0].email,
        payment_method: payment_method,
        invoice_settings: {
          default_payment_method: payment_method,
        },
      });

      await db.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customer.id, req.user.userId]
      );
    }

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Switchline ${plan_id.charAt(0).toUpperCase() + plan_id.slice(1)} Plan`
          },
          unit_amount: plan_id === 'basic' ? 999 : plan_id === 'pro' ? 1999 : 4999,
          recurring: {
            interval: 'month'
          }
        }
      }],
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent']
    });

    // Update user plan
    await db.query(
      'UPDATE users SET plan = $1, subscription_id = $2 WHERE id = $3',
      [plan_id, subscription.id, req.user.userId]
    );

    res.json({
      subscription_id: subscription.id,
      client_secret: subscription.latest_invoice.payment_intent.client_secret,
      status: subscription.status
    });
  } catch (error) {
    console.error('Subscription creation error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

app.post('/api/billing/cancel-subscription', authenticateToken, async (req, res) => {
  try {
    const userResult = await db.query(
      'SELECT subscription_id FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (!userResult.rows[0].subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const subscription = await stripe.subscriptions.update(
      userResult.rows[0].subscription_id,
      { cancel_at_period_end: true }
    );

    res.json({
      message: 'Subscription cancelled successfully',
      cancel_at: subscription.cancel_at
    });
  } catch (error) {
    console.error('Subscription cancellation error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Twilio Routes
app.get('/api/twilio/test', (req, res) => {
  res.json({ 
    message: 'Twilio integration ready',
    account_sid: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured'
  });
});

// Phone number search
app.get('/api/phone/search', authenticateToken, async (req, res) => {
  try {
    const { areaCode } = req.query;

    const numbers = await twilio.availablePhoneNumbers('US')
      .local
      .list({
        areaCode: areaCode,
        limit: 10
      });

    const formattedNumbers = numbers.map(number => ({
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      locality: number.locality,
      region: number.region,
      capabilities: number.capabilities
    }));

    res.json({ numbers: formattedNumbers });
  } catch (error) {
    console.error('Phone search error:', error);
    res.status(500).json({ error: 'Failed to search phone numbers' });
  }
});

// Purchase phone number
app.post('/api/phone/purchase', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Purchase number from Twilio
    const incomingPhoneNumber = await twilio.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${process.env.BASE_URL}/api/twilio/voice`,
      smsUrl: `${process.env.BASE_URL}/api/twilio/sms`
    });

    // Store in database
    await db.query(
      'INSERT INTO phone_numbers (user_id, phone_number, twilio_sid, area_code, location) VALUES ($1, $2, $3, $4, $5)',
      [
        req.user.userId,
        phoneNumber,
        incomingPhoneNumber.sid,
        phoneNumber.substring(2, 5), // Extract area code
        incomingPhoneNumber.friendlyName
      ]
    );

    res.json({
      message: 'Phone number purchased successfully',
      phoneNumber: phoneNumber,
      sid: incomingPhoneNumber.sid
    });
  } catch (error) {
    console.error('Phone purchase error:', error);
    res.status(500).json({ error: 'Failed to purchase phone number' });
  }
});

// Debug routes (remove in production)
app.get('/api/debug/user/:email', async (req, res) => {
  try {
    const user = await db.query('SELECT * FROM users WHERE email = $1', [req.params.email]);
    
    if (user.rows.length === 0) {
      return res.json({ exists: false });
    }

    const userData = user.rows[0];
    res.json({
      exists: true,
      email: userData.email,
      hasPassword: !!userData.password,
      passwordLength: userData.password?.length,
      plan: userData.plan,
      credits: userData.credits,
      status: userData.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/debug/create-test-user', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash('test123', 10);
    
    const result = await db.query(`
      INSERT INTO users (email, password, plan, credits, status) 
      VALUES ($1, $2, $3, $4, $5) 
      ON CONFLICT (email) DO UPDATE SET
        password = $2,
        plan = $3,
        credits = $4,
        status = $5
      RETURNING *
    `, ['test@switchline.com', hashedPassword, 'pro', 50, 'active']);
    
    res.json({ 
      message: 'Test user created/updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, async () => {
  console.log('='.repeat(50));
  console.log(`🚀 Switchline API server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`📞 Twilio: ${process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Configured' : 'Not configured'}`);
  console.log('='.repeat(50));
  console.log('');
  console.log('🔄 Setting up database...');
  
  // Setup database after server starts
  await setupDatabase();
  
  console.log('');
  console.log('✅ Your service is live 🎉');
  console.log('');
  console.log('/' + '='.repeat(48) + '/');
  console.log('');
  console.log(`🌐 Available at your primary URL: https://switchline-backend.onrender.com`);
  console.log('');
  console.log('/' + '='.repeat(48) + '/');
});

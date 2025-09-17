const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const stripe = require('stripe');
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

// Stripe configuration
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY environment variable is required');
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

// Raw body parser for Stripe webhooks (must be before express.json)
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

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
      'SELECT id, email, is_active FROM users WHERE id = $1 AND is_active = true',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: decoded.userId,
      email: decoded.email
    };

    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

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

// Create or retrieve Stripe customer
const getOrCreateStripeCustomer = async (userId, email, name) => {
  try {
    // Check if user already has a Stripe customer ID
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows[0]?.stripe_customer_id) {
      return userResult.rows[0].stripe_customer_id;
    }

    // Create new Stripe customer
    const customer = await stripeClient.customers.create({
      email: email,
      name: name,
      metadata: { userId: userId }
    });

    // Store customer ID in database
    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, userId]
    );

    return customer.id;
  } catch (error) {
    console.error('Error creating Stripe customer:', error);
    throw error;
  }
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

    // Test Stripe connection
    let stripeStatus = 'unknown';
    try {
      await stripeClient.accounts.retrieve();
      stripeStatus = 'connected';
    } catch (stripeError) {
      stripeStatus = 'disconnected';
    }

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      twilio: twilioStatus,
      stripe: stripeStatus,
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

    // Create Stripe customer
    try {
      await getOrCreateStripeCustomer(user.id, user.email, `${firstName} ${lastName}`);
    } catch (stripeError) {
      console.error('Failed to create Stripe customer:', stripeError);
      // Don't fail registration if Stripe fails
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Check if account is active
    if (!user.is_active) {
      return res.status(401).json({ error: 'Account not active' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
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
    res.status(500).json({ error: 'Login failed' });
  }
});

// =============================================================================
// STRIPE BILLING ROUTES
// =============================================================================

// Get subscription plans
app.get('/api/billing/plans', async (req, res) => {
  try {
    const plans = await pool.query(
      `SELECT id, name, price_cents, interval, phone_numbers_limit, 
              minutes_limit, sms_limit, features 
       FROM subscription_plans 
       WHERE active = true 
       ORDER BY price_cents ASC`
    );

    res.json({
      plans: plans.rows.map(plan => ({
        id: plan.id,
        name: plan.name,
        price: {
          cents: plan.price_cents,
          formatted: `$${(plan.price_cents / 100).toFixed(2)}`
        },
        interval: plan.interval,
        limits: {
          phoneNumbers: plan.phone_numbers_limit,
          minutes: plan.minutes_limit,
          sms: plan.sms_limit
        },
        features: plan.features
      }))
    });
  } catch (error) {
    console.error('Failed to fetch plans:', error);
    res.status(500).json({ error: 'Failed to fetch subscription plans' });
  }
});

// Get user's billing info
app.get('/api/billing/subscription', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.stripe_customer_id, u.subscription_status, u.plan_type,
              us.stripe_subscription_id, us.status, us.current_period_end,
              us.cancel_at_period_end, sp.name as plan_name, sp.price_cents,
              sp.phone_numbers_limit, sp.minutes_limit, sp.sms_limit
       FROM users u
       LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
       LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const user = result.rows[0];

    res.json({
      subscription: {
        status: user.subscription_status || 'free',
        planName: user.plan_name || 'Free',
        pricePerMonth: user.price_cents ? user.price_cents / 100 : 0,
        currentPeriodEnd: user.current_period_end,
        cancelAtPeriodEnd: user.cancel_at_period_end || false,
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

// Create payment intent for subscription
app.post('/api/billing/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }

    // Get plan details
    const planResult = await pool.query(
      'SELECT * FROM subscription_plans WHERE id = $1 AND active = true',
      [planId]
    );

    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const plan = planResult.rows[0];

    // Get or create Stripe customer
    const user = await pool.query('SELECT email, first_name, last_name FROM users WHERE id = $1', [req.user.id]);
    const customerId = await getOrCreateStripeCustomer(
      req.user.id, 
      user.rows[0].email, 
      `${user.rows[0].first_name} ${user.rows[0].last_name}`
    );

    // Create payment intent
    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: plan.price_cents,
      currency: 'usd',
      customer: customerId,
      metadata: {
        userId: req.user.id,
        planId: planId,
        planName: plan.name
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: plan.price_cents,
      planName: plan.name
    });

  } catch (error) {
    console.error('Payment intent creation failed:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Create subscription
app.post('/api/billing/create-subscription', authenticateToken, async (req, res) => {
  try {
    const { planId, paymentMethodId } = req.body;

    if (!planId || !paymentMethodId) {
      return res.status(400).json({ error: 'Plan ID and payment method are required' });
    }

    // Get plan details
    const planResult = await pool.query(
      'SELECT * FROM subscription_plans WHERE id = $1 AND active = true',
      [planId]
    );

    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const plan = planResult.rows[0];

    // Get user details
    const userResult = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];

    // Get or create Stripe customer
    const customerId = await getOrCreateStripeCustomer(
      req.user.id, 
      user.email, 
      `${user.first_name} ${user.last_name}`
    );

    // Attach payment method to customer
    await stripeClient.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default payment method
    await stripeClient.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    // Create subscription in Stripe
    const subscription = await stripeClient.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripe_price_id }],
      default_payment_method: paymentMethodId,
      metadata: {
        userId: req.user.id,
        planId: planId
      }
    });

    // Store subscription in database
    await pool.query(
      `INSERT INTO user_subscriptions 
       (user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, 
        current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        subscription.id,
        customerId,
        planId,
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000)
      ]
    );

    // Update user subscription status
    await pool.query(
      `UPDATE users SET 
       subscription_status = $1, 
       plan_type = $2,
       subscription_expires_at = $3
       WHERE id = $4`,
      [subscription.status, plan.name, new Date(subscription.current_period_end * 1000), req.user.id]
    );

    res.json({
      message: 'Subscription created successfully',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000)
      }
    });

  } catch (error) {
    console.error('Subscription creation failed:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Cancel subscription
app.post('/api/billing/cancel-subscription', authenticateToken, async (req, res) => {
  try {
    // Get user's active subscription
    const subResult = await pool.query(
      `SELECT stripe_subscription_id FROM user_subscriptions 
       WHERE user_id = $1 AND status = 'active'`,
      [req.user.id]
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const subscriptionId = subResult.rows[0].stripe_subscription_id;

    // Cancel subscription in Stripe (at period end)
    const subscription = await stripeClient.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    // Update database
    await pool.query(
      `UPDATE user_subscriptions SET cancel_at_period_end = true WHERE stripe_subscription_id = $1`,
      [subscriptionId]
    );

    res.json({
      message: 'Subscription will be cancelled at the end of the billing period',
      cancelAt: new Date(subscription.current_period_end * 1000)
    });

  } catch (error) {
    console.error('Subscription cancellation failed:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// =============================================================================
// STRIPE WEBHOOKS
// =============================================================================

app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send('Webhook signature verification failed');
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Log the event
    await pool.query(
      `INSERT INTO billing_events (stripe_event_id, event_type, metadata) 
       VALUES ($1, $2, $3)`,
      [event.id, event.type, JSON.stringify(event.data.object)]
    );

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Webhook handlers
const handleSubscriptionUpdate = async (subscription) => {
  const userId = subscription.metadata.userId;
  if (!userId) return;

  await pool.query(
    `UPDATE user_subscriptions SET 
     status = $1, current_period_start = $2, current_period_end = $3,
     cancel_at_period_end = $4, updated_at = CURRENT_TIMESTAMP
     WHERE stripe_subscription_id = $5`,
    [
      subscription.status,
      new Date(subscription.current_period_start * 1000),
      new Date(subscription.current_period_end * 1000),
      subscription.cancel_at_period_end,
      subscription.id
    ]
  );

  await pool.query(
    `UPDATE users SET 
     subscription_status = $1, subscription_expires_at = $2
     WHERE id = $3`,
    [subscription.status, new Date(subscription.current_period_end * 1000), userId]
  );
};

const handleSubscriptionCanceled = async (subscription) => {
  const userId = subscription.metadata.userId;
  if (!userId) return;

  await pool.query(
    `UPDATE user_subscriptions SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
     WHERE stripe_subscription_id = $1`,
    [subscription.id]
  );

  await pool.query(
    `UPDATE users SET subscription_status = 'canceled', plan_type = 'free'
     WHERE id = $1`,
    [userId]
  );
};

const handlePaymentSucceeded = async (invoice) => {
  if (invoice.subscription) {
    const subscription = await stripeClient.subscriptions.retrieve(invoice.subscription);
    await handleSubscriptionUpdate(subscription);
  }
};

const handlePaymentFailed = async (invoice) => {
  const userId = invoice.metadata?.userId;
  if (!userId) return;

  // Log failed payment
  await pool.query(
    `INSERT INTO billing_events (user_id, stripe_event_id, event_type, amount_cents, status)
     VALUES ($1, $2, 'payment_failed', $3, 'failed')`,
    [userId, invoice.id, invoice.amount_paid]
  );
};

// =============================================================================
// USER MANAGEMENT ROUTES
// =============================================================================

// Get current user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.email_verified,
              u.created_at, u.last_login, u.subscription_status, u.plan_type,
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
        phoneNumbersCount: parseInt(user.phone_numbers_count),
        subscription: {
          status: user.subscription_status || 'free',
          planType: user.plan_type || 'Free'
        }
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

    // Check subscription limits
    const userResult = await client.query(
      `SELECT u.id, u.subscription_status, sp.phone_numbers_limit,
              COUNT(pn.id) as current_numbers
       FROM users u
       LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.status = 'active'
       LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
       LEFT JOIN phone_numbers pn ON u.id = pn.user_id AND pn.status = 'active'
       WHERE u.id = $1
       GROUP BY u.id, sp.phone_numbers_limit`,
      [req.user.id]
    );

    const user = userResult.rows[0];
    const limit = user.phone_numbers_limit || 1;
    const current = parseInt(user.current_numbers) || 0;

    if (current >= limit) {
      return res.status(403).json({ 
        error: `Phone number limit reached. Your plan allows ${limit} number(s).` 
      });
    }

    // Purchase number from Twilio
    const twilioNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${process.env.BACKEND_ROOT || 'https://switchline-backend.onrender.com'}/api/webhooks/twilio/voice`,
      smsUrl: `${process.env.BACKEND_ROOT || 'https://switchline-backend.onrender.com'}/api/webhooks/twilio/sms`,
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
    const { From, To, Body, MessageSid } = req.body;

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
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Configured' : 'Not configured'}`);
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

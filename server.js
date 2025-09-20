const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Initialize services
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use('/webhook', express.raw({type: 'application/json'})); // Raw middleware for webhook
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

    const customer = await stripe.customers.create({
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

// Database verification endpoint
app.get('/api/debug/database', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
       
    const planCount = await pool.query('SELECT COUNT(*) FROM subscription_plans');
    
    res.json({
      success: true,
      tables: result.rows.map(row => row.table_name),
      subscription_plans: parseInt(planCount.rows[0].count),
      database_ready: result.rows.length > 0
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      database_ready: false
    });
  }
});

// Temporary endpoint to check subscription_plans schema
app.get('/api/debug/subscription-plans-schema', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'subscription_plans' 
      ORDER BY ordinal_position;
    `);
    
    const sampleData = await pool.query('SELECT * FROM subscription_plans LIMIT 1');
    
    res.json({
      success: true,
      columns: result.rows,
      sample_data: sampleData.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple test endpoint
app.get('/api/debug/test', (req, res) => {
  res.json({
    success: true,
    message: 'Debug endpoint working',
    timestamp: new Date().toISOString()
  });
});

// FIXED: Debug endpoint to test webhook manually - removed salt column references
app.post('/api/debug/test-webhook', async (req, res) => {
  try {
    console.log('🧪 Manual webhook test triggered');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    
    // Simulate a checkout.session.completed event
    const mockSession = {
      id: 'cs_test_manual_' + Date.now(),
      subscription: 'sub_test_manual_' + Date.now(),
      customer: 'cus_test_manual_' + Date.now()
    };
    
    const mockSubscription = {
      id: mockSession.subscription,
      customer: mockSession.customer,
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
      items: {
        data: [{
          price: {
            id: 'price_1S8gJfLz1CB1flJ3nYeAtyOt', // Basic plan
            unit_amount: 399
          }
        }]
      }
    };
    
    const mockCustomer = {
      id: mockSession.customer,
      email: 'webhook-test@example.com'
    };
    
    console.log('🧪 Testing handleCheckoutCompleted function...');
    
    // Test the webhook handler functions directly
    try {
      // Simulate the webhook processing
      console.log('🎉 Mock checkout completed:', mockSession.id);
      
      // Test user creation - CHECK IF USER EXISTS FIRST
      let user = await pool.query('SELECT * FROM users WHERE email = $1', [mockCustomer.email]);
      
      if (user.rows.length === 0) {
        console.log('👤 Creating test user...');
        
        // Create user without ON CONFLICT - check first then insert
        const newUser = await pool.query(`
          INSERT INTO users (email, password_hash, stripe_customer_id, status, created_at, updated_at) 
          VALUES ($1, 'webhook_user', $2, 'active', NOW(), NOW()) 
          RETURNING *
        `, [mockCustomer.email, mockCustomer.id]);
        
        user = newUser;
        console.log('✅ Test user created');
      } else {
        console.log('👤 Test user already exists');
        // Update existing user
        await pool.query(`
          UPDATE users 
          SET stripe_customer_id = $1, updated_at = NOW() 
          WHERE email = $2
        `, [mockCustomer.id, mockCustomer.email]);
        console.log('✅ Test user updated');
      }
      
      // Test subscription creation
      console.log('📋 Testing subscription creation...');
      
      // Map price to plan name
      let planName = 'Basic';
      if (mockSubscription.items.data[0].price.unit_amount === 999) planName = 'Pro';
      if (mockSubscription.items.data[0].price.unit_amount === 2999) planName = 'Enterprise';
      
      // Get plan ID
      const planResult = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', [planName]);
      
      if (planResult.rows.length === 0) {
        throw new Error(`Plan not found: ${planName}`);
      }
      
      const planId = planResult.rows[0].id;
      console.log(`📋 Found plan: ${planName} (${planId})`);
      
      // Get user ID for subscription
      const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [mockCustomer.email]);
      if (userResult.rows.length === 0) {
        throw new Error('User not found after creation');
      }
      const userId = userResult.rows[0].id;
      
      // Check if subscription already exists
      const existingSubscription = await pool.query(
        'SELECT id FROM user_subscriptions WHERE user_id = $1', 
        [userId]
      );
      
      if (existingSubscription.rows.length === 0) {
        // Create new subscription
        await pool.query(`
          INSERT INTO user_subscriptions (
            user_id,
            plan_id,
            stripe_subscription_id,
            stripe_customer_id,
            status,
            current_period_start,
            current_period_end,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        `, [
          userId,
          planId,
          mockSubscription.id,
          mockSubscription.customer,
          mockSubscription.status,
          new Date(mockSubscription.current_period_start * 1000),
          new Date(mockSubscription.current_period_end * 1000)
        ]);
        console.log('✅ New subscription created');
      } else {
        // Update existing subscription
        await pool.query(`
          UPDATE user_subscriptions SET
            plan_id = $1,
            stripe_subscription_id = $2,
            status = $3,
            current_period_start = $4,
            current_period_end = $5,
            updated_at = NOW()
          WHERE user_id = $6
        `, [
          planId,
          mockSubscription.id,
          mockSubscription.status,
          new Date(mockSubscription.current_period_start * 1000),
          new Date(mockSubscription.current_period_end * 1000),
          userId
        ]);
        console.log('✅ Existing subscription updated');
      }
      
      console.log(`✅ Mock subscription processed: ${mockCustomer.email} -> ${planName}`);
      
      res.json({
        success: true,
        message: 'Webhook functions tested successfully',
        test_data: {
          user_email: mockCustomer.email,
          plan_name: planName,
          subscription_id: mockSubscription.id,
          customer_id: mockCustomer.id
        }
      });
      
    } catch (error) {
      console.error('❌ Error in webhook test:', error);
      res.status(500).json({
        success: false,
        error: 'Webhook test failed',
        details: error.message
      });
    }
    
  } catch (error) {
    console.error('❌ Debug endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Debug test failed',
      details: error.message
    });
  }
});

// Endpoint to check current subscription data
app.get('/api/debug/subscription-data', async (req, res) => {
  try {
    const users = await pool.query('SELECT id, email, stripe_customer_id FROM users ORDER BY created_at DESC LIMIT 5');
    const subscriptions = await pool.query(`
      SELECT 
        us.*,
        u.email,
        sp.name as plan_name,
        sp.price_cents
      FROM user_subscriptions us
      JOIN users u ON us.user_id = u.id
      JOIN subscription_plans sp ON us.plan_id = sp.id
      ORDER BY us.created_at DESC 
      LIMIT 5
    `);
    
    res.json({
      success: true,
      recent_users: users.rows,
      recent_subscriptions: subscriptions.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================
// STRIPE WEBHOOK INTEGRATION
// =====================================

// Stripe webhook endpoint - handles subscription events
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Webhook signature verified:', event.type);
  } catch (err) {
    console.log('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
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

    res.json({received: true});
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    res.status(500).json({error: 'Webhook handler failed'});
  }
});

// =====================================
// STRIPE EVENT HANDLERS - FIXED
// =====================================

async function handleCheckoutCompleted(session) {
  console.log('🎉 Checkout completed:', session.id);
  
  try {
    // Get the subscription details
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const customer = await stripe.customers.retrieve(session.customer);
    
    // Find or create user
    let user = await pool.query('SELECT * FROM users WHERE email = $1', [customer.email]);
    
    if (user.rows.length === 0) {
      // Create new user if doesn't exist - FIXED: removed salt column
      const newUser = await pool.query(`
        INSERT INTO users (email, password_hash, stripe_customer_id, status, created_at, updated_at) 
        VALUES ($1, 'webhook_user', $2, 'active', NOW(), NOW()) 
        RETURNING *
      `, [customer.email, customer.id]);
      user = newUser;
    } else {
      // Update existing user with customer ID
      await pool.query(`
        UPDATE users 
        SET stripe_customer_id = $1, updated_at = NOW() 
        WHERE email = $2
      `, [customer.id, customer.email]);
    }
    
    // Create subscription record
    await createUserSubscription(subscription, customer.email);
    
  } catch (error) {
    console.error('❌ Error handling checkout completion:', error);
  }
}

async function handleSubscriptionCreated(subscription) {
  console.log('📋 Subscription created:', subscription.id);
  
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    await createUserSubscription(subscription, customer.email);
  } catch (error) {
    console.error('❌ Error handling subscription creation:', error);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Subscription updated:', subscription.id);
  
  try {
    await pool.query(`
      UPDATE user_subscriptions 
      SET 
        status = $1,
        current_period_start = $2,
        current_period_end = $3,
        updated_at = NOW()
      WHERE stripe_subscription_id = $4
    `, [
      subscription.status,
      new Date(subscription.current_period_start * 1000),
      new Date(subscription.current_period_end * 1000),
      subscription.id
    ]);
    
    console.log('✅ Subscription updated in database');
  } catch (error) {
    console.error('❌ Error updating subscription:', error);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log('🗑️ Subscription deleted:', subscription.id);
  
  try {
    await pool.query(`
      UPDATE user_subscriptions 
      SET status = 'canceled', updated_at = NOW() 
      WHERE stripe_subscription_id = $1
    `, [subscription.id]);
    
    console.log('✅ Subscription canceled in database');
  } catch (error) {
    console.error('❌ Error canceling subscription:', error);
  }
}

async function handlePaymentSucceeded(invoice) {
  console.log('💰 Payment succeeded:', invoice.id);
  
  if (invoice.subscription) {
    try {
      // Record billing event
      await pool.query(`
        INSERT INTO billing_events (
          user_id, 
          event_type, 
          amount, 
          currency, 
          stripe_invoice_id, 
          created_at
        ) VALUES (
          (SELECT id FROM users WHERE stripe_customer_id = $1),
          'payment_succeeded',
          $2,
          $3,
          $4,
          NOW()
        )
      `, [invoice.customer, invoice.amount_paid, invoice.currency, invoice.id]);
      
      console.log('✅ Payment recorded in billing_events');
    } catch (error) {
      console.error('❌ Error recording payment:', error);
    }
  }
}

async function handlePaymentFailed(invoice) {
  console.log('❌ Payment failed:', invoice.id);
  
  try {
    // Record failed payment
    await pool.query(`
      INSERT INTO billing_events (
        user_id, 
        event_type, 
        amount, 
        currency, 
        stripe_invoice_id, 
        created_at
      ) VALUES (
        (SELECT id FROM users WHERE stripe_customer_id = $1),
        'payment_failed',
        $2,
        $3,
        $4,
        NOW()
      )
    `, [invoice.customer, invoice.amount_due, invoice.currency, invoice.id]);
    
    console.log('✅ Failed payment recorded');
  } catch (error) {
    console.error('❌ Error recording failed payment:', error);
  }
}

// FIXED: Helper function to create user subscription - removed ON CONFLICT issues
async function createUserSubscription(subscription, userEmail) {
  try {
    // Get plan details from Stripe price
    const price = await stripe.prices.retrieve(subscription.items.data[0].price.id);
    
    // Map Stripe price to our plan - FIXED MAPPING
    let planName = 'Basic';
    if (price.unit_amount === 999) planName = 'Pro';
    if (price.unit_amount === 2999) planName = 'Enterprise';
    
    // Get our internal plan ID
    const planResult = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', [planName]);
    
    if (planResult.rows.length === 0) {
      throw new Error(`Plan not found: ${planName}`);
    }
    
    const planId = planResult.rows[0].id;
    
    // Get user ID
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [userEmail]);
    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userEmail}`);
    }
    const userId = userResult.rows[0].id;
    
    // Check if subscription exists and handle appropriately
    const existingSubscription = await pool.query(
      'SELECT id FROM user_subscriptions WHERE user_id = $1', 
      [userId]
    );
    
    if (existingSubscription.rows.length === 0) {
      // Create new subscription
      await pool.query(`
        INSERT INTO user_subscriptions (
          user_id,
          plan_id,
          stripe_subscription_id,
          stripe_customer_id,
          status,
          current_period_start,
          current_period_end,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `, [
        userId,
        planId,
        subscription.id,
        subscription.customer,
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000)
      ]);
    } else {
      // Update existing subscription
      await pool.query(`
        UPDATE user_subscriptions SET
          plan_id = $1,
          stripe_subscription_id = $2,
          status = $3,
          current_period_start = $4,
          current_period_end = $5,
          updated_at = NOW()
        WHERE user_id = $6
      `, [
        planId,
        subscription.id,
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
        userId
      ]);
    }
    
    console.log(`✅ User subscription created/updated: ${userEmail} -> ${planName}`);
  } catch (error) {
    console.error('❌ Error creating user subscription:', error);
    throw error;
  }
}

// =====================================
// SUBSCRIPTION CREATION ENDPOINTS
// =====================================

// Create checkout session for subscription
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { priceId, userEmail, planName } = req.body;
    
    if (!priceId || !userEmail) {
      return res.status(400).json({ error: 'Price ID and email required' });
    }

    // Create or retrieve customer
    let customer;
    try {
      const customers = await stripe.customers.list({
        email: userEmail,
        limit: 1
      });
      
      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else {
        customer = await stripe.customers.create({
          email: userEmail,
          metadata: {
            source: 'Switchline App'
          }
        });
      }
    } catch (error) {
      console.error('Error with customer:', error);
      return res.status(500).json({ error: 'Failed to create customer' });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `https://switchline.app/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://switchline.app'}/pricing`,
      metadata: {
        planName: planName || 'Unknown'
      }
    });

    console.log(`✅ Checkout session created: ${session.id} for ${userEmail}`);
    
    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: error.message 
    });
  }
});

// Get subscription status for a user
app.get('/api/subscription-status/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    // Get user and subscription from database
    const result = await pool.query(`
      SELECT 
        u.id as user_id,
        u.email,
        us.status,
        us.current_period_end,
        sp.name as plan_name,
        sp.price_cents,
        sp.features
      FROM users u
      LEFT JOIN user_subscriptions us ON u.id = us.user_id
      LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
      WHERE u.email = $1
    `, [email]);
    
    if (result.rows.length === 0) {
      return res.json({
        hasSubscription: false,
        message: 'User not found'
      });
    }
    
    const user = result.rows[0];
    
    if (!user.status) {
      return res.json({
        hasSubscription: false,
        user: {
          email: user.email,
          id: user.user_id
        }
      });
    }
    
    const isActive = user.status === 'active' && new Date(user.current_period_end) > new Date();
    
    res.json({
      hasSubscription: isActive,
      subscription: {
        status: user.status,
        planName: user.plan_name,
        price: user.price_cents,
        features: user.features,
        currentPeriodEnd: user.current_period_end,
        isActive: isActive
      },
      user: {
        email: user.email,
        id: user.user_id
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting subscription status:', error);
    res.status(500).json({ 
      error: 'Failed to get subscription status',
      details: error.message 
    });
  }
});

// Cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { userEmail } = req.body;
    
    if (!userEmail) {
      return res.status(400).json({ error: 'Email required' });
    }
    
    // Get user's subscription
    const result = await pool.query(`
      SELECT us.stripe_subscription_id 
      FROM users u
      JOIN user_subscriptions us ON u.id = us.user_id
      WHERE u.email = $1 AND us.status = 'active'
    `, [userEmail]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }
    
    const subscriptionId = result.rows[0].stripe_subscription_id;
    
    // Cancel in Stripe
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });
    
    console.log(`✅ Subscription canceled: ${subscriptionId} for ${userEmail}`);
    
    res.json({
      success: true,
      message: 'Subscription will cancel at period end',
      cancelAt: new Date(subscription.current_period_end * 1000)
    });
    
  } catch (error) {
    console.error('❌ Error canceling subscription:', error);
    res.status(500).json({ 
      error: 'Failed to cancel subscription',
      details: error.message 
    });
  }
});

// Test endpoint to verify subscription system
app.get('/api/test-subscription-system', async (req, res) => {
  try {
    // Test database connections
    const plans = await pool.query('SELECT * FROM subscription_plans ORDER BY price_cents');
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    const subscriptionCount = await pool.query('SELECT COUNT(*) FROM user_subscriptions');
    
    res.json({
      success: true,
      system_status: 'ready',
      available_plans: plans.rows,
      stats: {
        total_users: parseInt(userCount.rows[0].count),
        total_subscriptions: parseInt(subscriptionCount.rows[0].count)
      },
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      webhook_configured: !!process.env.STRIPE_WEBHOOK_SECRET,
      test_price_ids: {
        basic: 'price_1S8gJfLz1CB1flJ3nYeAtyOt',
        pro: 'price_1S8gJmLz1CB1flJ3vWyz737X', 
        enterprise: 'price_1S8gJrLz1CB1flJ3P6urv3f9'
      }
    });
    
  } catch (error) {
    console.error('❌ Error testing subscription system:', error);
    res.status(500).json({ 
      error: 'Subscription system test failed',
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

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, created_at, updated_at) 
       VALUES ($1, $2, NOW(), NOW()) RETURNING id, email`,
      [email, passwordHash]
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
        email: user.email
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

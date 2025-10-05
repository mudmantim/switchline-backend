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

// Test database connection on startup
pool.connect()
  .then(() => console.log('✅ Database connected successfully'))
  .catch(err => console.error('❌ Database connection error:', err));

// Middleware
app.use('/webhook', express.raw({type: 'application/json'})); // Raw middleware for webhook
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// ============================================================================
// STREAKFIT WORKOUT DATA
// ============================================================================

const BEGINNER_WORKOUTS = [
  { id: 1, name: "Jumping Jacks", reps: 20, gold: 10, xp: 15, category: "cardio" },
  { id: 2, name: "Wall Push-ups", reps: 10, gold: 15, xp: 20, category: "strength" },
  { id: 3, name: "Bodyweight Squats", reps: 15, gold: 12, xp: 18, category: "strength" },
  { id: 4, name: "Knee Push-ups", reps: 8, gold: 12, xp: 18, category: "strength" },
  { id: 5, name: "Standing Calf Raises", reps: 20, gold: 8, xp: 12, category: "strength" },
  { id: 6, name: "Arm Circles", reps: 30, gold: 8, xp: 12, category: "warmup" },
  { id: 7, name: "Marching in Place", duration: 60, gold: 10, xp: 15, category: "cardio" },
  { id: 8, name: "Seated Toe Touches", reps: 10, gold: 8, xp: 12, category: "flexibility" },
  { id: 9, name: "Chair Dips", reps: 8, gold: 15, xp: 20, category: "strength" },
  { id: 10, name: "Side Leg Raises", reps: 12, gold: 10, xp: 15, category: "strength" }
];

const INTERMEDIATE_WORKOUTS = [
  { id: 11, name: "Burpees", reps: 10, gold: 25, xp: 35, category: "cardio" },
  { id: 12, name: "Push-ups", reps: 15, gold: 20, xp: 30, category: "strength" },
  { id: 13, name: "Jump Squats", reps: 15, gold: 22, xp: 32, category: "strength" },
  { id: 14, name: "Mountain Climbers", reps: 20, gold: 20, xp: 30, category: "cardio" },
  { id: 15, name: "Lunges", reps: 20, gold: 18, xp: 28, category: "strength" },
  { id: 16, name: "Plank Hold", duration: 45, gold: 25, xp: 35, category: "core" },
  { id: 17, name: "High Knees", duration: 45, gold: 18, xp: 28, category: "cardio" },
  { id: 18, name: "Diamond Push-ups", reps: 10, gold: 25, xp: 35, category: "strength" },
  { id: 19, name: "Russian Twists", reps: 30, gold: 20, xp: 30, category: "core" },
  { id: 20, name: "Box Jumps", reps: 12, gold: 28, xp: 38, category: "strength" }
];

const ADVANCED_WORKOUTS = [
  { id: 21, name: "One-Arm Push-ups", reps: 8, gold: 40, xp: 55, category: "strength" },
  { id: 22, name: "Pistol Squats", reps: 10, gold: 45, xp: 60, category: "strength" },
  { id: 23, name: "Handstand Push-ups", reps: 5, gold: 50, xp: 70, category: "strength" },
  { id: 24, name: "Burpee Pull-ups", reps: 10, gold: 45, xp: 60, category: "cardio" },
  { id: 25, name: "Muscle-ups", reps: 5, gold: 55, xp: 75, category: "strength" },
  { id: 26, name: "Dragon Flags", reps: 8, gold: 50, xp: 70, category: "core" },
  { id: 27, name: "Clapping Push-ups", reps: 12, gold: 40, xp: 55, category: "strength" },
  { id: 28, name: "L-Sit Hold", duration: 30, gold: 45, xp: 60, category: "core" },
  { id: 29, name: "Archer Push-ups", reps: 10, gold: 42, xp: 57, category: "strength" },
  { id: 30, name: "Box Jump Overs", reps: 15, gold: 38, xp: 52, category: "cardio" }
];

const ALL_WORKOUTS = [...BEGINNER_WORKOUTS, ...INTERMEDIATE_WORKOUTS, ...ADVANCED_WORKOUTS];

// ============================================================================
// DUAL-MODE UTILITIES
// ============================================================================

// Utility function to detect if request is in test mode
const isTestMode = (req) => {
  if (req.query.test === 'true') return true;
  if (req.query.live === 'true') return false;
  if (req.headers['x-test-mode'] === 'true') return true;
  if (req.headers['x-live-mode'] === 'true') return false;
  if (req.body && req.body.testMode === true) return true;
  if (req.body && req.body.liveMode === true) return false;
  return true;
};

// Utility function to log mode-specific actions
const logModeAction = (action, testMode, details = {}) => {
  const prefix = testMode ? '🧪 TEST:' : '🔴 LIVE:';
  console.log(`${prefix} ${action}`, details);
};

// Authentication middleware for Switchline
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

// Authentication middleware for StreakFit (different token payload)
const authenticateStreakFitToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: 'Access token required' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false,
        error: 'Invalid or expired token' 
      });
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
    version: '2.0.0',
    dual_mode_support: true,
    apps: ['switchline', 'streakfit']
  });
});

app.get('/test-basic', (req, res) => {
  const testMode = isTestMode(req);
  res.json({
    message: 'Server is working!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    mode: testMode ? 'test' : 'production'
  });
});

app.get('/api/twilio/test', async (req, res) => {
  try {
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({
      success: true,
      message: 'Twilio connection successful',
      accountSid: account.sid,
      accountStatus: account.status,
      dual_mode_ready: true
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
      database_ready: result.rows.length > 0,
      dual_mode_support: true
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

// FIXED: Debug endpoint to test webhook manually - completely removed ON CONFLICT
app.post('/api/debug/test-webhook', async (req, res) => {
  try {
    console.log('🧪 Manual webhook test triggered');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    
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
      current_period_end: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
      items: {
        data: [{
          price: {
            id: 'price_1S8gJfLz1CB1flJ3nYeAtyOt',
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
    
    try {
      console.log('🎉 Mock checkout completed:', mockSession.id);
      
      let user = await pool.query('SELECT * FROM users WHERE email = $1', [mockCustomer.email]);
      
      if (user.rows.length === 0) {
        console.log('👤 Creating test user...');
        
        const newUser = await pool.query(`
          INSERT INTO users (email, password_hash, stripe_customer_id, status, created_at, updated_at) 
          VALUES ($1, 'webhook_user', $2, 'active', NOW(), NOW()) 
          RETURNING *
        `, [mockCustomer.email, mockCustomer.id]);
        
        user = newUser;
        console.log('✅ Test user created');
      } else {
        console.log('👤 Test user already exists');
        await pool.query(`
          UPDATE users 
          SET stripe_customer_id = $1, updated_at = NOW() 
          WHERE email = $2
        `, [mockCustomer.id, mockCustomer.email]);
        console.log('✅ Test user updated');
      }
      
      console.log('📋 Testing subscription creation...');
      
      let planName = 'Basic';
      if (mockSubscription.items.data[0].price.unit_amount === 999) planName = 'Pro';
      if (mockSubscription.items.data[0].price.unit_amount === 2999) planName = 'Enterprise';
      
      const planResult = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', [planName]);
      
      if (planResult.rows.length === 0) {
        throw new Error(`Plan not found: ${planName}`);
      }
      
      const planId = planResult.rows[0].id;
      console.log(`📋 Found plan: ${planName} (${planId})`);
      
      const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [mockCustomer.email]);
      if (userResult.rows.length === 0) {
        throw new Error('User not found after creation');
      }
      const userId = userResult.rows[0].id;
      
      const existingSubscription = await pool.query(
        'SELECT id FROM user_subscriptions WHERE user_id = $1', 
        [userId]
      );
      
      if (existingSubscription.rows.length === 0) {
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

// ============================================================================
// DUAL-MODE ENDPOINTS
// ============================================================================

app.post('/api/numbers/test-purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const testMode = true;

    logModeAction('Number test purchase request', testMode, { phoneNumber });

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    res.json({
      success: true,
      message: 'Test purchase simulation completed',
      number: {
        phoneNumber: phoneNumber,
        status: 'test_active',
        testMode: true,
        created_at: new Date().toISOString(),
        cost: 0,
        monthly_cost: 0
      },
      warning: 'This was a test purchase. No actual charges applied.'
    });

    logModeAction('Test purchase completed successfully', testMode, { phoneNumber });

  } catch (error) {
    console.error('Test purchase error:', error);
    res.status(500).json({ 
      error: 'Test purchase failed',
      details: error.message,
      testMode: true
    });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { to, body, from, testMode: requestedTestMode } = req.body;
    const testMode = requestedTestMode !== undefined ? requestedTestMode : isTestMode(req);

    logModeAction('SMS send request', testMode, { to, from, bodyLength: body?.length });

    if (!to || !body) {
      return res.status(400).json({ error: 'To and body are required' });
    }

    if (testMode) {
      console.log(`🧪 TEST SMS: From ${from || 'auto'} to ${to}: ${body}`);
      
      await new Promise(resolve => setTimeout(resolve, 500));

      res.json({
        success: true,
        message: 'Test SMS simulation completed',
        messageSid: 'test_msg_' + Date.now(),
        status: 'test_sent',
        testMode: true,
        cost: 0,
        details: {
          from: from || '(test-number)',
          to: to,
          body: body,
          timestamp: new Date().toISOString()
        }
      });

      logModeAction('Test SMS sent successfully', testMode);
      return;
    }

    let fromNumber = from;
    if (!fromNumber && req.user) {
      const activeNumberResult = await pool.query(`
        SELECT phone_number 
        FROM phone_numbers 
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1
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

    if (req.user) {
      await pool.query(`
        INSERT INTO messages (user_id, from_number, to_number, body, direction, twilio_sid, status, created_at)
        VALUES ($1, $2, $3, $4, 'outbound', $5, $6, NOW())
      `, [req.user.id, fromNumber, to, body, message.sid, message.status]);
    }

    res.json({
      success: true,
      messageSid: message.sid,
      status: message.status,
      testMode: false,
      cost: 0.0075
    });

    logModeAction('Production SMS sent successfully', testMode, { sid: message.sid });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      error: 'Failed to send message',
      details: error.message,
      testMode: isTestMode(req)
    });
  }
});

app.get('/api/mode/detect', (req, res) => {
  const testMode = isTestMode(req);
  res.json({
    testMode: testMode,
    productionMode: !testMode,
    detectionMethod: 'url_parameters_or_headers',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/mode/config', (req, res) => {
  const testMode = isTestMode(req);
  res.json({
    currentMode: testMode ? 'test' : 'production',
    settings: {
      showCosts: !testMode,
      enableRealPurchases: !testMode,
      showWarnings: !testMode,
      simulateDelay: testMode
    },
    endpoints: {
      test: {
        numberPurchase: '/api/numbers/test-purchase',
        messageSend: '/api/messages/send?test=true'
      },
      production: {
        numberPurchase: '/api/numbers/purchase',
        messageSend: '/api/messages/send?live=true'
      }
    }
  });
});

// ============================================================================
// STRIPE WEBHOOK AND EVENT HANDLERS
// ============================================================================

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Webhook signature verified:', event.type);
  } catch (err) {
    console.log('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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

async function handleCheckoutCompleted(session) {
  console.log('🎉 Checkout completed:', session.id);
  
  try {
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const customer = await stripe.customers.retrieve(session.customer);
    
    let user = await pool.query('SELECT * FROM users WHERE email = $1', [customer.email]);
    
    if (user.rows.length === 0) {
      const newUser = await pool.query(`
        INSERT INTO users (email, password_hash, stripe_customer_id, status, created_at, updated_at) 
        VALUES ($1, 'webhook_user', $2, 'active', NOW(), NOW()) 
        RETURNING *
      `, [customer.email, customer.id]);
      user = newUser;
    } else {
      await pool.query(`
        UPDATE users 
        SET stripe_customer_id = $1, updated_at = NOW() 
        WHERE email = $2
      `, [customer.id, customer.email]);
    }
    
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

async function createUserSubscription(subscription, userEmail) {
  try {
    const price = await stripe.prices.retrieve(subscription.items.data[0].price.id);
    
    let planName = 'Basic';
    if (price.unit_amount === 999) planName = 'Pro';
    if (price.unit_amount === 2999) planName = 'Enterprise';
    
    const planResult = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', [planName]);
    
    if (planResult.rows.length === 0) {
      throw new Error(`Plan not found: ${planName}`);
    }
    
    const planId = planResult.rows[0].id;
    
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [userEmail]);
    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userEmail}`);
    }
    const userId = userResult.rows[0].id;
    
    const existingSubscription = await pool.query(
      'SELECT id FROM user_subscriptions WHERE user_id = $1', 
      [userId]
    );
    
    if (existingSubscription.rows.length === 0) {
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

// ============================================================================
// SUBSCRIPTION ENDPOINTS
// ============================================================================

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { priceId, userEmail, planName } = req.body;
    
    if (!priceId || !userEmail) {
      return res.status(400).json({ error: 'Price ID and email required' });
    }

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

app.get('/api/subscription-status/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
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

app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { userEmail } = req.body;
    
    if (!userEmail) {
      return res.status(400).json({ error: 'Email required' });
    }
    
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

app.get('/api/test-subscription-system', async (req, res) => {
  try {
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
      dual_mode_support: true,
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
// AUTHENTICATION ENDPOINTS (Switchline)
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, status FROM users WHERE email = $1',
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

    await pool.query('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

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
        email: user.email
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
    const testMode = isTestMode(req);

    logModeAction('Number search request', testMode, { areaCode });

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
      capabilities: number.capabilities,
      testMode: testMode,
      cost: testMode ? 0 : 1.15,
      monthlyCost: testMode ? 0 : 1.00
    }));

    res.json({
      success: true,
      numbers: formattedNumbers,
      testMode: testMode,
      message: testMode ? 'Test search results - no charges apply' : 'Live search results'
    });

    logModeAction('Number search completed', testMode, { found: formattedNumbers.length });

  } catch (error) {
    console.error('Number search error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to search for numbers',
      details: error.message,
      testMode: isTestMode(req)
    });
  }
});

app.post('/api/numbers/purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const testMode = isTestMode(req);

    logModeAction('Number purchase request', testMode, { phoneNumber });

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    if (testMode) {
      return res.json({
        success: true,
        message: 'Redirected to test purchase',
        redirect: '/api/numbers/test-purchase',
        testMode: true
      });
    }

    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required for production purchases' });
    }

    const userResult = await pool.query(`
      SELECT COUNT(pn.id) as current_count
      FROM phone_numbers pn 
      WHERE pn.user_id = $1 AND pn.status != 'burned'
    `, [req.user.id]);

    const currentCount = parseInt(userResult.rows[0].current_count) || 0;
    
    if (currentCount >= 5) {
      return res.status(400).json({ 
        error: 'Phone number limit reached for your plan',
        current: currentCount
      });
    }

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${process.env.BASE_URL}/webhook/twilio/voice`,
      smsUrl: `${process.env.BASE_URL}/webhook/twilio/sms`
    });

    const result = await pool.query(`
      INSERT INTO phone_numbers (user_id, phone_number, twilio_sid, status, created_at)
      VALUES ($1, $2, $3, 'active', NOW())
      RETURNING id, phone_number, status, created_at
    `, [req.user.id, phoneNumber, purchasedNumber.sid]);

    res.json({
      success: true,
      number: result.rows[0],
      testMode: false,
      cost: 1.15,
      monthlyCost: 1.00
    });

    logModeAction('Production number purchased successfully', testMode, { sid: purchasedNumber.sid });

  } catch (error) {
    console.error('Number purchase error:', error);
    res.status(500).json({ 
      error: 'Failed to purchase number',
      details: error.message,
      testMode: isTestMode(req)
    });
  }
});

app.get('/api/numbers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, phone_number, status, created_at
      FROM phone_numbers 
      WHERE user_id = $1 AND status != 'burned'
      ORDER BY created_at DESC
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
    const testMode = isTestMode(req);

    logModeAction('Burn number request', testMode, { numberId: id });

    const numberResult = await pool.query(
      'SELECT phone_number, twilio_sid FROM phone_numbers WHERE id = $1 AND user_id = $2 AND status = $3',
      [id, req.user.id, 'active']
    );

    if (numberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Number not found or already burned' });
    }

    const { phone_number, twilio_sid } = numberResult.rows[0];

    if (!testMode && twilio_sid && twilio_sid !== 'test_sid') {
      await twilioClient.incomingPhoneNumbers(twilio_sid).remove();
    }

    await pool.query(`
      UPDATE phone_numbers 
      SET status = 'burned', updated_at = NOW() 
      WHERE id = $1
    `, [id]);

    res.json({
      success: true,
      message: testMode ? 'Number test burn completed' : 'Number burned successfully',
      testMode: testMode
    });

    logModeAction('Number burned successfully', testMode, { phoneNumber: phone_number });

  } catch (error) {
    console.error('Burn number error:', error);
    res.status(500).json({ 
      error: 'Failed to burn number',
      testMode: isTestMode(req)
    });
  }
});

// ============================================================================
// MESSAGING ENDPOINTS
// ============================================================================

app.get('/api/messages', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, from_number, to_number, body, direction, status, created_at
      FROM messages 
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);

    res.json({
      success: true,
      messages: result.rows
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================================================
// CALLING ENDPOINTS
// ============================================================================

app.post('/api/calls/make', authenticateToken, async (req, res) => {
  try {
    const { to, from } = req.body;
    const testMode = isTestMode(req);

    logModeAction('Make call request', testMode, { to, from });

    if (!to) {
      return res.status(400).json({ error: 'To number is required' });
    }

    if (testMode) {
      res.json({
        success: true,
        callSid: 'test_call_' + Date.now(),
        status: 'test_initiated',
        testMode: true,
        cost: 0,
        message: 'Test call simulation completed'
      });
      
      logModeAction('Test call simulated', testMode);
      return;
    }

    let fromNumber = from;
    if (!fromNumber) {
      const activeNumberResult = await pool.query(`
        SELECT phone_number 
        FROM phone_numbers 
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1
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
      INSERT INTO calls (user_id, from_number, to_number, direction, twilio_sid, status, created_at)
      VALUES ($1, $2, $3, 'outbound', $4, $5, NOW())
    `, [req.user.id, fromNumber, to, call.sid, call.status]);

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      testMode: false,
      estimatedCost: 0.013
    });

    logModeAction('Production call initiated', testMode, { sid: call.sid });

  } catch (error) {
    console.error('Make call error:', error);
    res.status(500).json({ 
      error: 'Failed to make call',
      testMode: isTestMode(req)
    });
  }
});

app.get('/api/calls', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, from_number, to_number, direction, status, created_at
      FROM calls 
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);

    res.json({
      success: true,
      calls: result.rows
    });

  } catch (error) {
    console.error('Get calls error:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// ============================================================================
// BILLING ENDPOINTS
// ============================================================================

app.get('/api/billing/subscription', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.*,
        us.status as subscription_status,
        sp.name as plan_name, 
        sp.price_cents, 
        sp.features
      FROM users u
      LEFT JOIN user_subscriptions us ON u.id = us.user_id
      LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
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
        status: user.subscription_status || 'inactive',
        features: user.features || []
      },
      stripeCustomerId: user.stripe_customer_id
    });
  } catch (error) {
    console.error('Failed to fetch subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription info' });
  }
});

app.get('/api/billing/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        event_type,
        amount,
        currency,
        stripe_invoice_id,
        created_at
      FROM billing_events 
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.user.id]);

    res.json({
      success: true,
      billing_history: result.rows
    });

  } catch (error) {
    console.error('Get billing history error:', error);
    res.status(500).json({ error: 'Failed to fetch billing history' });
  }
});

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

app.post('/webhook/twilio/voice', (req, res) => {
  const testMode = isTestMode(req);
  const twiml = new twilio.twiml.VoiceResponse();
  
  if (testMode) {
    twiml.say('Hello from Switchline Test Mode! This is a simulated call.');
  } else {
    twiml.say('Hello from Switchline! This call is being handled.');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/twilio/sms', async (req, res) => {
  try {
    const { From, To, Body, MessageSid } = req.body;
    const testMode = isTestMode(req);

    logModeAction('Received SMS webhook', testMode, { from: From, to: To });

    const userResult = await pool.query(
      'SELECT user_id FROM phone_numbers WHERE phone_number = $1 AND status = $2',
      [To, 'active']
    );

    if (userResult.rows.length > 0) {
      await pool.query(`
        INSERT INTO messages (user_id, from_number, to_number, body, direction, twilio_sid, status, created_at)
        VALUES ($1, $2, $3, $4, 'inbound', $5, $6, NOW())
      `, [userResult.rows[0].user_id, From, To, Body, MessageSid, testMode ? 'test_received' : 'received']);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('SMS webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============================================================================
// CONVERSATIONS ENDPOINTS
// ============================================================================

app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT
        CASE 
          WHEN direction = 'inbound' THEN from_number
          ELSE to_number
        END as contact_number,
        MAX(created_at) as last_message_time,
        COUNT(*) as message_count
      FROM messages 
      WHERE user_id = $1
      GROUP BY contact_number
      ORDER BY last_message_time DESC
      LIMIT 20
    `, [req.user.id]);

    res.json({
      success: true,
      conversations: result.rows
    });

  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

app.get('/api/conversations/:phoneNumber', authenticateToken, async (req, res) => {
  try {
    const { phoneNumber } = req.params;

    const result = await pool.query(`
      SELECT id, from_number, to_number, body, direction, status, created_at
      FROM messages 
      WHERE user_id = $1 
      AND (from_number = $2 OR to_number = $2)
      ORDER BY created_at ASC
    `, [req.user.id, phoneNumber]);

    res.json({
      success: true,
      messages: result.rows
    });

  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    const userCheck = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (userCheck.rows.length === 0 || !userCheck.rows[0].email.includes('admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM phone_numbers WHERE status = $1', ['active']),
      pool.query('SELECT COUNT(*) as count FROM messages'),
      pool.query('SELECT COUNT(*) as count FROM calls'),
      pool.query('SELECT COUNT(*) as count FROM user_subscriptions WHERE status = $1', ['active'])
    ]);

    res.json({
      success: true,
      stats: {
        total_users: parseInt(stats[0].rows[0].count),
        active_numbers: parseInt(stats[1].rows[0].count),
        total_messages: parseInt(stats[2].rows[0].count),
        total_calls: parseInt(stats[3].rows[0].count),
        active_subscriptions: parseInt(stats[4].rows[0].count)
      }
    });

  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// ============================================================================
// SECURITY ENDPOINTS
// ============================================================================

app.post('/api/security/log-event', authenticateToken, async (req, res) => {
  try {
    const { event_type, details } = req.body;

    await pool.query(`
      INSERT INTO security_events (user_id, event_type, details, ip_address, user_agent, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      req.user.id,
      event_type,
      details,
      req.ip || req.connection.remoteAddress,
      req.headers['user-agent']
    ]);

    res.json({
      success: true,
      message: 'Security event logged'
    });

  } catch (error) {
    console.error('Log security event error:', error);
    res.status(500).json({ error: 'Failed to log security event' });
  }
});

// ============================================================================
// STREAKFIT AUTHENTICATION
// ============================================================================

app.post('/api/streakfit/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Name is required'
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    const existingUser = await pool.query(
      'SELECT * FROM streakfit_users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await pool.query(
      `INSERT INTO streakfit_users (name, email, password_hash, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING id, name, email, created_at`,
      [name.trim(), email.trim(), passwordHash]
    );

    const newUser = userResult.rows[0];

    await pool.query(
      `INSERT INTO streakfit_streaks (user_id, current_streak, longest_streak, total_calories, last_completed) 
       VALUES ($1, 0, 0, 0, NULL)`,
      [newUser.id]
    );

    await pool.query(
      `INSERT INTO streakfit_user_progression (user_id, level, total_gold, total_xp, total_gems) 
       VALUES ($1, 'beginner', 0, 0, 0)`,
      [newUser.id]
    );

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email
      },
      token: token
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create account'
    });
  }
});

app.post('/api/streakfit/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const userResult = await pool.query(
      'SELECT * FROM streakfit_users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const streakResult = await pool.query(
      'SELECT * FROM streakfit_streaks WHERE user_id = $1',
      [userId]
    );

    const progressionResult = await pool.query(
      'SELECT * FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const challengesResult = await pool.query(`
      SELECT * FROM streakfit_challenges 
      WHERE user_id = $1 
      ORDER BY completed_at DESC 
      LIMIT 30`,
      [userId]
    );

    res.json({
      success: true,
      user: userResult.rows[0],
      streak: streakResult.rows[0] || {
        current_streak: 0,
        longest_streak: 0,
        total_calories: 0
      },
      progression: progressionResult.rows[0] || {
        level: 'beginner',
        total_gold: 0,
        total_xp: 0,
        total_gems: 0
      },
      recent_challenges: challengesResult.rows
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user stats'
    });
  }
});

// ============================================================================
// TRIVIA ENDPOINTS
// ============================================================================

app.get('/api/streakfit/trivia/random', async (req, res) => {
  try {
    const { difficulty, category, age_group } = req.query;
    
    const token = req.headers['authorization']?.split(' ')[1];
    let userId = null;
    
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch (err) {
        // Invalid token - continue without filtering
      }
    }
    
    let query = 'SELECT * FROM trivia_questions WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (userId) {
      paramCount++;
      query += ` AND id NOT IN (
        SELECT question_id FROM streakfit_trivia_answers 
        WHERE user_id = ${paramCount}
      )`;
      params.push(userId);
    }

    if (difficulty) {
      paramCount++;
      query += ` AND difficulty = ${paramCount}`;
      params.push(difficulty);
    }

    if (category) {
      paramCount++;
      query += ` AND category = ${paramCount}`;
      params.push(category);
    }

    if (age_group) {
      paramCount++;
      query += ` AND age_group = ${paramCount}`;
      params.push(age_group);
    }

    query += ' ORDER BY RANDOM() LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      let resetQuery = 'SELECT * FROM trivia_questions WHERE 1=1';
      const resetParams = [];
      let resetCount = 0;
      
      if (difficulty) {
        resetCount++;
        resetQuery += ` AND difficulty = ${resetCount}`;
        resetParams.push(difficulty);
      }
      if (category) {
        resetCount++;
        resetQuery += ` AND category = ${resetCount}`;
        resetParams.push(category);
      }
      if (age_group) {
        resetCount++;
        resetQuery += ` AND age_group = ${resetCount}`;
        resetParams.push(age_group);
      }
      
      resetQuery += ' ORDER BY RANDOM() LIMIT 1';
      const resetResult = await pool.query(resetQuery, resetParams);
      
      if (resetResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No questions found matching criteria'
        });
      }
      
      const question = resetResult.rows[0];
      return res.json({
        success: true,
        allAnswered: true,
        question: {
          id: question.id,
          question: question.question,
          options: question.options,
          category: question.category,
          difficulty: question.difficulty,
          age_group: question.age_group,
          gems_value: question.gems_value
        }
      });
    }

    const question = result.rows[0];

    res.json({
      success: true,
      question: {
        id: question.id,
        question: question.question,
        options: question.options,
        category: question.category,
        difficulty: question.difficulty,
        age_group: question.age_group,
        gems_value: question.gems_value
      }
    });

  } catch (error) {
    console.error('Get random trivia error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trivia question'
    });
  }
});

app.post('/api/streakfit/trivia/answer', async (req, res) => {
  try {
    const { questionId, answer } = req.body;

    if (questionId === undefined || answer === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Question ID and answer are required'
      });
    }

    const result = await pool.query(
      'SELECT correct_answer, explanation, gems_value, category FROM trivia_questions WHERE id = $1',
      [questionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Question not found'
      });
    }

    const question = result.rows[0];
    const isCorrect = question.correct_answer === parseInt(answer);
    const gemsEarned = isCorrect ? question.gems_value : 0;

    const token = req.headers['authorization']?.split(' ')[1];
    let userId = null;
    
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.userId;
        
        await pool.query(`
          INSERT INTO streakfit_trivia_answers 
          (user_id, question_id, answer_given, is_correct, gems_earned, answered_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id, question_id) 
          DO UPDATE SET 
            answer_given = $3,
            is_correct = $4,
            gems_earned = $5,
            answered_at = NOW()
        `, [userId, questionId, answer, isCorrect, gemsEarned]);
        
      } catch (err) {
        console.log('Token validation failed:', err.message);
      }
    }

    res.json({
      success: true,
      correct: isCorrect,
      correctAnswer: question.correct_answer,
      explanation: question.explanation,
      gemsEarned: gemsEarned,
      category: question.category,
      tracked: userId !== null
    });

  } catch (error) {
    console.error('Submit trivia answer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit answer'
    });
  }
});

app.get('/api/streakfit/trivia/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        category,
        COUNT(*) as question_count,
        COUNT(*) FILTER (WHERE difficulty = 'easy') as easy_count,
        COUNT(*) FILTER (WHERE difficulty = 'medium') as medium_count,
        COUNT(*) FILTER (WHERE difficulty = 'hard') as hard_count
      FROM trivia_questions
      GROUP BY category
      ORDER BY category
    `);

    res.json({
      success: true,
      categories: result.rows
    });

  } catch (error) {
    console.error('Get trivia categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch categories'
    });
  }
});

app.get('/api/streakfit/trivia/stats', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_answered,
        COUNT(*) FILTER (WHERE is_correct = true) as correct_count,
        SUM(gems_earned) as total_gems
      FROM streakfit_trivia_answers
      WHERE user_id = $1
    `, [userId]);

    const categoryStats = await pool.query(`
      SELECT 
        tq.category,
        COUNT(*) as answered,
        COUNT(*) FILTER (WHERE ta.is_correct = true) as correct,
        SUM(ta.gems_earned) as gems
      FROM streakfit_trivia_answers ta
      JOIN trivia_questions tq ON ta.question_id = tq.id
      WHERE ta.user_id = $1
      GROUP BY tq.category
      ORDER BY tq.category
    `, [userId]);

    const difficultyStats = await pool.query(`
      SELECT 
        tq.difficulty,
        COUNT(*) as answered,
        COUNT(*) FILTER (WHERE ta.is_correct = true) as correct
      FROM streakfit_trivia_answers ta
      JOIN trivia_questions tq ON ta.question_id = tq.id
      WHERE ta.user_id = $1
      GROUP BY tq.difficulty
      ORDER BY tq.difficulty
    `, [userId]);

    const recentAnswers = await pool.query(`
      SELECT 
        ta.question_id,
        ta.is_correct,
        ta.gems_earned,
        ta.answered_at,
        tq.question,
        tq.category,
        tq.difficulty
      FROM streakfit_trivia_answers ta
      JOIN trivia_questions tq ON ta.question_id = tq.id
      WHERE ta.user_id = $1
      ORDER BY ta.answered_at DESC
      LIMIT 10
    `, [userId]);

    const stats = statsResult.rows[0];
    const totalAnswered = parseInt(stats.total_answered) || 0;
    const correctCount = parseInt(stats.correct_count) || 0;
    const accuracy = totalAnswered > 0 ? Math.round((correctCount / totalAnswered) * 100) : 0;

    res.json({
      success: true,
      stats: {
        totalAnswered: totalAnswered,
        correctAnswers: correctCount,
        accuracy: accuracy,
        totalGemsEarned: parseInt(stats.total_gems) || 0
      },
      byCategory: categoryStats.rows,
      byDifficulty: difficultyStats.rows,
      recentAnswers: recentAnswers.rows
    });

  } catch (error) {
    console.error('Get trivia stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trivia stats'
    });
  }
});

// ============================================================================
// DATABASE SETUP
// ============================================================================

app.get('/api/streakfit/setup-database', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_streaks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES streakfit_users(id) ON DELETE CASCADE,
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        total_calories INTEGER DEFAULT 0,
        last_completed TIMESTAMP,
        UNIQUE(user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_challenges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES streakfit_users(id) ON DELETE CASCADE,
        challenge_id INTEGER NOT NULL,
        challenge_name VARCHAR(255) NOT NULL,
        calories INTEGER NOT NULL,
        completed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_workout_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES streakfit_users(id) ON DELETE CASCADE,
        exercise_id INTEGER NOT NULL,
        exercise_name VARCHAR(255) NOT NULL,
        gold_earned INTEGER NOT NULL,
        xp_earned INTEGER NOT NULL,
        completed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_popup_challenges (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES streakfit_users(id) ON DELETE CASCADE,
        challenge_type VARCHAR(50) NOT NULL,
        challenge_data JSONB NOT NULL,
        scheduled_time TIMESTAMP NOT NULL,
        opened_at TIMESTAMP,
        completed_at TIMESTAMP,
        time_to_complete INTEGER,
        gems_earned INTEGER DEFAULT 0,
        speed_bonus INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streakfit_user_progression (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES streakfit_users(id) ON DELETE CASCADE,
        level VARCHAR(50) DEFAULT 'beginner',
        total_gold INTEGER DEFAULT 0,
        total_xp INTEGER DEFAULT 0,
        total_gems INTEGER DEFAULT 0,
        UNIQUE(user_id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_popup_user_scheduled 
      ON streakfit_popup_challenges(user_id, scheduled_time)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_popup_completed 
      ON streakfit_popup_challenges(completed_at)
    `);

    res.json({
      success: true,
      message: 'StreakFit database tables created successfully'
    });

  } catch (error) {
    console.error('Database setup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`Switchline backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Dual-mode support enabled`);
  console.log(`🧪 Test endpoints available at /api/*/test-* routes`);
  console.log(`🔴 Production endpoints available with ?live=true parameter`);
  console.log(`🔥 StreakFit API available at /api/streakfit/* (AUTHENTICATED)`);
  console.log(`💪 StreakFit workout system with pop-ups enabled`);
});(
      'SELECT * FROM streakfit_streaks WHERE user_id = $1',
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      streak: streakResult.rows[0] || {
        current_streak: 0,
        total_calories: 0
      },
      token: token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// ============================================================================
// POPUP CHALLENGE SYSTEM
// ============================================================================

async function generateDailyPopups(userId) {
  try {
    await pool.query(`
      DELETE FROM streakfit_popup_challenges 
      WHERE user_id = $1 AND completed_at IS NULL
    `, [userId]);

    const userLevel = await pool.query(
      'SELECT level FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const level = userLevel.rows[0]?.level || 'beginner';
    
    let workoutPool;
    if (level === 'advanced') {
      workoutPool = ADVANCED_WORKOUTS;
    } else if (level === 'intermediate') {
      workoutPool = INTERMEDIATE_WORKOUTS;
    } else {
      workoutPool = BEGINNER_WORKOUTS;
    }

    const selectedExercises = [];
    const usedIds = new Set();

    while (selectedExercises.length < 2) {
      const randomExercise = workoutPool[Math.floor(Math.random() * workoutPool.length)];
      if (!usedIds.has(randomExercise.id)) {
        selectedExercises.push(randomExercise);
        usedIds.add(randomExercise.id);
      }
    }

    const triviaResult = await pool.query(`
      SELECT * FROM trivia_questions 
      ORDER BY RANDOM() 
      LIMIT 1
    `);

    const triviaQuestion = triviaResult.rows[0];

    const today = new Date();
    today.setHours(8, 0, 0, 0);
    const endTime = new Date(today);
    endTime.setHours(20, 0, 0, 0);

    const timeSlots = [];
    for (let i = 0; i < 3; i++) {
      const randomTime = new Date(today.getTime() + Math.random() * (endTime.getTime() - today.getTime()));
      timeSlots.push(randomTime);
    }
    timeSlots.sort((a, b) => a - b);

    const popups = [];

    const popup1 = await pool.query(`
      INSERT INTO streakfit_popup_challenges 
      (user_id, challenge_type, challenge_data, scheduled_time, created_at)
      VALUES ($1, 'exercise', $2, $3, NOW())
      RETURNING *
    `, [userId, JSON.stringify(selectedExercises[0]), timeSlots[0]]);
    popups.push(popup1.rows[0]);

    const popup2 = await pool.query(`
      INSERT INTO streakfit_popup_challenges 
      (user_id, challenge_type, challenge_data, scheduled_time, created_at)
      VALUES ($1, 'trivia', $2, $3, NOW())
      RETURNING *
    `, [userId, JSON.stringify({
      id: triviaQuestion.id,
      question: triviaQuestion.question,
      options: triviaQuestion.options,
      gems_value: triviaQuestion.gems_value,
      category: triviaQuestion.category
    }), timeSlots[1]]);
    popups.push(popup2.rows[0]);

    const popup3 = await pool.query(`
      INSERT INTO streakfit_popup_challenges 
      (user_id, challenge_type, challenge_data, scheduled_time, created_at)
      VALUES ($1, 'exercise', $2, $3, NOW())
      RETURNING *
    `, [userId, JSON.stringify(selectedExercises[1]), timeSlots[2]]);
    popups.push(popup3.rows[0]);

    console.log(`✅ Generated 3 daily popups for user ${userId}`);
    return popups;

  } catch (error) {
    console.error('Error generating daily popups:', error);
    throw error;
  }
}

app.get('/api/streakfit/active-popup', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existingPopups = await pool.query(`
      SELECT COUNT(*) as count
      FROM streakfit_popup_challenges
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, today]);

    if (parseInt(existingPopups.rows[0].count) === 0) {
      await generateDailyPopups(userId);
    }

    const result = await pool.query(`
      SELECT * FROM streakfit_popup_challenges
      WHERE user_id = $1 
      AND completed_at IS NULL
      AND scheduled_time <= NOW()
      ORDER BY scheduled_time ASC
      LIMIT 1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        hasPopup: false,
        message: 'No popup challenges available right now'
      });
    }

    const popup = result.rows[0];

    res.json({
      success: true,
      hasPopup: true,
      popup: {
        id: popup.id,
        type: popup.challenge_type,
        data: popup.challenge_data,
        scheduledTime: popup.scheduled_time
      }
    });

  } catch (error) {
    console.error('Get active popup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active popup'
    });
  }
});

app.post('/api/streakfit/popup-challenge/complete', authenticateStreakFitToken, async (req, res) => {
  try {
    const { popupId, answer, timeToComplete } = req.body;
    const userId = req.user.userId;

    if (!popupId) {
      return res.status(400).json({
        success: false,
        error: 'Popup ID is required'
      });
    }

    const popupResult = await pool.query(
      'SELECT * FROM streakfit_popup_challenges WHERE id = $1 AND user_id = $2',
      [popupId, userId]
    );

    if (popupResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Popup not found'
      });
    }

    const popup = popupResult.rows[0];

    if (popup.completed_at) {
      return res.status(400).json({
        success: false,
        error: 'Popup already completed'
      });
    }

    let gemsEarned = 0;
    let goldEarned = 0;
    let xpEarned = 0;
    let speedBonus = 0;

    if (timeToComplete && timeToComplete < 60) {
      speedBonus = Math.floor((60 - timeToComplete) / 10) * 5;
    }

    if (popup.challenge_type === 'exercise') {
      const exercise = popup.challenge_data;
      goldEarned = exercise.gold;
      xpEarned = exercise.xp;
      gemsEarned = 10 + speedBonus;

    } else if (popup.challenge_type === 'trivia') {
      const triviaResult = await pool.query(
        'SELECT correct_answer, gems_value FROM trivia_questions WHERE id = $1',
        [popup.challenge_data.id]
      );

      if (triviaResult.rows.length > 0) {
        const trivia = triviaResult.rows[0];
        const isCorrect = trivia.correct_answer === parseInt(answer);

        if (isCorrect) {
          gemsEarned = trivia.gems_value + speedBonus;
        } else {
          gemsEarned = speedBonus;
        }

        await pool.query(`
          INSERT INTO streakfit_trivia_answers 
          (user_id, question_id, answer_given, is_correct, gems_earned, answered_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id, question_id) 
          DO UPDATE SET 
            answer_given = $3,
            is_correct = $4,
            gems_earned = $5,
            answered_at = NOW()
        `, [userId, popup.challenge_data.id, answer, isCorrect, gemsEarned]);
      }
    }

    await pool.query(`
      UPDATE streakfit_popup_challenges
      SET completed_at = NOW(),
          time_to_complete = $1,
          gems_earned = $2,
          speed_bonus = $3
      WHERE id = $4
    `, [timeToComplete, gemsEarned, speedBonus, popupId]);

    await pool.query(`
      UPDATE streakfit_user_progression
      SET total_gems = total_gems + $1,
          total_gold = total_gold + $2,
          total_xp = total_xp + $3
      WHERE user_id = $4
    `, [gemsEarned, goldEarned, xpEarned, userId]);

    const progressionResult = await pool.query(
      'SELECT * FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const progression = progressionResult.rows[0];
    let leveledUp = false;
    let newLevel = progression.level;

    if (progression.level === 'beginner' && progression.total_xp >= 1000) {
      newLevel = 'intermediate';
      leveledUp = true;
      await pool.query(
        'UPDATE streakfit_user_progression SET level = $1 WHERE user_id = $2',
        ['intermediate', userId]
      );
    } else if (progression.level === 'intermediate' && progression.total_xp >= 3000) {
      newLevel = 'advanced';
      leveledUp = true;
      await pool.query(
        'UPDATE streakfit_user_progression SET level = $1 WHERE user_id = $2',
        ['advanced', userId]
      );
    }

    res.json({
      success: true,
      rewards: {
        gems: gemsEarned,
        gold: goldEarned,
        xp: xpEarned,
        speedBonus: speedBonus
      },
      leveledUp: leveledUp,
      newLevel: newLevel,
      totalGems: progression.total_gems + gemsEarned,
      totalGold: progression.total_gold + goldEarned,
      totalXp: progression.total_xp + xpEarned
    });

  } catch (error) {
    console.error('Complete popup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete popup challenge'
    });
  }
});

app.get('/api/streakfit/popup-history', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT * FROM streakfit_popup_challenges
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId]);

    res.json({
      success: true,
      history: result.rows
    });

  } catch (error) {
    console.error('Get popup history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch popup history'
    });
  }
});

// ============================================================================
// DAILY WORKOUT SYSTEM
// ============================================================================

app.get('/api/streakfit/daily-workout', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const userLevel = await pool.query(
      'SELECT level FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const level = userLevel.rows[0]?.level || 'beginner';
    
    let workoutPool;
    if (level === 'advanced') {
      workoutPool = ADVANCED_WORKOUTS;
    } else if (level === 'intermediate') {
      workoutPool = INTERMEDIATE_WORKOUTS;
    } else {
      workoutPool = BEGINNER_WORKOUTS;
    }

    const today = new Date();
    const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    
    const selectedExercises = [];
    const usedIds = new Set();
    let tempSeed = seed;

    while (selectedExercises.length < 5) {
      tempSeed = (tempSeed * 9301 + 49297) % 233280;
      const index = tempSeed % workoutPool.length;
      const exercise = workoutPool[index];
      
      if (!usedIds.has(exercise.id)) {
        selectedExercises.push(exercise);
        usedIds.add(exercise.id);
      }
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const completedResult = await pool.query(`
      SELECT exercise_id FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedIds = new Set(completedResult.rows.map(r => r.exercise_id));

    const workoutWithStatus = selectedExercises.map(exercise => ({
      ...exercise,
      completed: completedIds.has(exercise.id)
    }));

    res.json({
      success: true,
      workout: workoutWithStatus,
      level: level,
      date: today.toISOString().split('T')[0]
    });

  } catch (error) {
    console.error('Get daily workout error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch daily workout'
    });
  }
});

app.post('/api/streakfit/complete-exercise', authenticateStreakFitToken, async (req, res) => {
  try {
    const { exerciseId } = req.body;
    const userId = req.user.userId;

    if (!exerciseId) {
      return res.status(400).json({
        success: false,
        error: 'Exercise ID is required'
      });
    }

    const exercise = ALL_WORKOUTS.find(w => w.id === exerciseId);

    if (!exercise) {
      return res.status(404).json({
        success: false,
        error: 'Exercise not found'
      });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const existingCompletion = await pool.query(`
      SELECT * FROM streakfit_workout_progress
      WHERE user_id = $1 AND exercise_id = $2 AND completed_at >= $3
    `, [userId, exerciseId, todayStart]);

    if (existingCompletion.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Exercise already completed today'
      });
    }

    await pool.query(`
      INSERT INTO streakfit_workout_progress
      (user_id, exercise_id, exercise_name, gold_earned, xp_earned, completed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, exerciseId, exercise.name, exercise.gold, exercise.xp]);

    await pool.query(`
      UPDATE streakfit_user_progression
      SET total_gold = total_gold + $1,
          total_xp = total_xp + $2
      WHERE user_id = $3
    `, [exercise.gold, exercise.xp, userId]);

    const progressionResult = await pool.query(
      'SELECT * FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const progression = progressionResult.rows[0];
    let leveledUp = false;
    let newLevel = progression.level;

    if (progression.level === 'beginner' && progression.total_xp >= 1000) {
      newLevel = 'intermediate';
      leveledUp = true;
      await pool.query(
        'UPDATE streakfit_user_progression SET level = $1 WHERE user_id = $2',
        ['intermediate', userId]
      );
    } else if (progression.level === 'intermediate' && progression.total_xp >= 3000) {
      newLevel = 'advanced';
      leveledUp = true;
      await pool.query(
        'UPDATE streakfit_user_progression SET level = $1 WHERE user_id = $2',
        ['advanced', userId]
      );
    }

    const completedTodayResult = await pool.query(`
      SELECT COUNT(*) as count FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedCount = parseInt(completedTodayResult.rows[0].count);
    const dailyWorkoutComplete = completedCount >= 5;

    if (dailyWorkoutComplete) {
      const streakResult = await pool.query(
        'SELECT * FROM streakfit_streaks WHERE user_id = $1',
        [userId]
      );

      if (streakResult.rows.length > 0) {
        const streak = streakResult.rows[0];
        const lastCompleted = streak.last_completed ? new Date(streak.last_completed) : null;
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        let newStreak = 1;
        if (lastCompleted && lastCompleted >= yesterday) {
          newStreak = streak.current_streak + 1;
        }

        const longestStreak = Math.max(newStreak, streak.longest_streak);

        await pool.query(`
          UPDATE streakfit_streaks
          SET current_streak = $1,
              longest_streak = $2,
              last_completed = NOW()
          WHERE user_id = $3
        `, [newStreak, longestStreak, userId]);
      }
    }

    res.json({
      success: true,
      exercise: {
        id: exercise.id,
        name: exercise.name,
        goldEarned: exercise.gold,
        xpEarned: exercise.xp
      },
      dailyWorkoutComplete: dailyWorkoutComplete,
      leveledUp: leveledUp,
      newLevel: newLevel,
      totalGold: progression.total_gold + exercise.gold,
      totalXp: progression.total_xp + exercise.xp
    });

  } catch (error) {
    console.error('Complete exercise error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete exercise'
    });
  }
});

app.get('/api/streakfit/progression', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      'SELECT * FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Progression not found'
      });
    }

    const progression = result.rows[0];

    let xpForNextLevel = 0;
    if (progression.level === 'beginner') {
      xpForNextLevel = 1000;
    } else if (progression.level === 'intermediate') {
      xpForNextLevel = 3000;
    } else {
      xpForNextLevel = progression.total_xp;
    }

    res.json({
      success: true,
      progression: {
        level: progression.level,
        totalGold: progression.total_gold,
        totalXp: progression.total_xp,
        totalGems: progression.total_gems,
        xpForNextLevel: xpForNextLevel,
        xpProgress: progression.level === 'advanced' ? 100 : Math.min(100, (progression.total_xp / xpForNextLevel) * 100)
      }
    });

  } catch (error) {
    console.error('Get progression error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch progression'
    });
  }
});

// ============================================================================
// STREAKFIT LEADERBOARD AND STATS
// ============================================================================

app.get('/api/streakfit/leaderboard', authenticateStreakFitToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.name,
        s.current_streak,
        s.longest_streak,
        s.total_calories,
        p.level,
        p.total_gold,
        p.total_xp,
        p.total_gems
      FROM streakfit_users u
      JOIN streakfit_streaks s ON u.id = s.user_id
      LEFT JOIN streakfit_user_progression p ON u.id = p.user_id
      ORDER BY s.current_streak DESC, p.total_xp DESC
      LIMIT 50
    `);

    res.json({
      success: true,
      leaderboard: result.rows
    });

  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leaderboard'
    });
  }
});

app.post('/api/streakfit/complete-challenge', authenticateStreakFitToken, async (req, res) => {
  try {
    const { challengeId, challengeName, calories } = req.body;
    const userId = req.user.userId;

    if (!challengeId || !challengeName || !calories) {
      return res.status(400).json({
        success: false,
        error: 'Challenge ID, name, and calories are required'
      });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const existingChallenge = await pool.query(
      `SELECT * FROM streakfit_challenges 
       WHERE user_id = $1 AND completed_at >= $2`,
      [userId, todayStart]
    );

    if (existingChallenge.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'You have already completed a challenge today'
      });
    }

    await pool.query(
      `INSERT INTO streakfit_challenges (user_id, challenge_id, challenge_name, calories, completed_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, challengeId, challengeName, calories]
    );

    const streakResult = await pool.query(
      'SELECT * FROM streakfit_streaks WHERE user_id = $1',
      [userId]
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let totalCalories = 0;

    if (streakResult.rows.length > 0) {
      const streak = streakResult.rows[0];
      const lastCompleted = streak.last_completed ? new Date(streak.last_completed) : null;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);

      if (lastCompleted && lastCompleted >= yesterday) {
        currentStreak = streak.current_streak + 1;
      } else {
        currentStreak = 1;
      }

      longestStreak = Math.max(currentStreak, streak.longest_streak);
      totalCalories = streak.total_calories + calories;
    } else {
      currentStreak = 1;
      longestStreak = 1;
      totalCalories = calories;
    }

    await pool.query(
      `INSERT INTO streakfit_streaks (user_id, current_streak, longest_streak, total_calories, last_completed)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         current_streak = $2,
         longest_streak = $3,
         total_calories = $4,
         last_completed = NOW()`,
      [userId, currentStreak, longestStreak, totalCalories]
    );

    res.json({
      success: true,
      streak: {
        current_streak: currentStreak,
        longest_streak: longestStreak,
        total_calories: totalCalories
      }
    });

  } catch (error) {
    console.error('Complete challenge error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete challenge'
    });
  }
});

app.get('/api/streakfit/user/:userId', authenticateStreakFitToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (parseInt(userId) !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const userResult = await pool.query(
      'SELECT id, name, email, created_at FROM streakfit_users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const streakResult = await pool.query

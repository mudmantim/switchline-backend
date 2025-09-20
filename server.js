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

// =====================================
// STRIPE WEBHOOK INTEGRATION
// =====================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Stripe webhook endpoint - handles subscription events
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
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
// STRIPE EVENT HANDLERS
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
      // Create new user if doesn't exist
      const newUser = await pool.query(`
        INSERT INTO users (email, stripe_customer_id, created_at, updated_at) 
        VALUES ($1, $2, NOW(), NOW()) 
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
  console.log('📝 Subscription created:', subscription.id);
  
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

// Helper function to create user subscription
async function createUserSubscription(subscription, userEmail) {
  try {
    // Get plan details from Stripe price
    const price = await stripe.prices.retrieve(subscription.items.data[0].price.id);
    
    // Map Stripe price to our plan
    let planName = 'Basic';
    if (price.unit_amount === 999) planName = 'Pro';
    if (price.unit_amount === 2999) planName = 'Enterprise';
    
    // Get our internal plan ID
    const planResult = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', [planName]);
    
    if (planResult.rows.length === 0) {
      throw new Error(`Plan not found: ${planName}`);
    }
    
    const planId = planResult.rows[0].id;
    
    // Create or update subscription
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
      ) VALUES (
        (SELECT id FROM users WHERE email = $1),
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        NOW(),
        NOW()
      ) ON CONFLICT (user_id) DO UPDATE SET
        plan_id = $2,
        stripe_subscription_id = $3,
        status = $5,
        current_period_start = $6,
        current_period_end = $7,
        updated_at = NOW()
    `, [
      userEmail,
      planId,
      subscription.id,
      subscription.customer,
      subscription.status,
      new Date(subscription.current_period_start * 1000),
      new Date(subscription.current_period_end * 1000)
    ]);
    
    console.log(`✅ User subscription created/updated: ${userEmail} -> ${planName}`);
  } catch (error) {
    console.error('❌ Error creating user subscription:', error);
    throw error;
  }
}

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

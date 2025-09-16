const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const stripe = require('stripe');

const app = express();

// Environment variables
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://switchline.app';

// Initialize Twilio and Stripe clients
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const stripeClient = stripe(STRIPE_SECRET_KEY);

// Middleware
app.use(cors({
  origin: [FRONTEND_URL, 'https://switchline.app', 'http://localhost:3000', 'http://localhost:8080'],
  credentials: true
}));

// Raw body for Stripe webhooks
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for other routes
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Switchline Backend API with Stripe Integration',
    version: '2.0.0',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
    features: ['Twilio Integration', 'Stripe Payments', 'Phone Number Purchase']
  });
});

// Basic connectivity test
app.get('/test-basic', (req, res) => {
  res.json({
    status: 'success',
    message: 'Basic test endpoint working',
    timestamp: new Date().toISOString()
  });
});

// Twilio connection test
app.get('/api/twilio/test', async (req, res) => {
  try {
    console.log('Testing Twilio connection...');
    console.log('Account SID:', TWILIO_ACCOUNT_SID ? 'configured' : 'missing');
    console.log('Auth Token:', TWILIO_AUTH_TOKEN ? 'configured' : 'missing');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(500).json({
        status: 'error',
        message: 'Twilio credentials not configured',
        accountSid: TWILIO_ACCOUNT_SID ? 'configured' : 'missing',
        authToken: TWILIO_AUTH_TOKEN ? 'configured' : 'missing'
      });
    }

    // Test Twilio connection by fetching account info
    const account = await twilioClient.api.accounts(TWILIO_ACCOUNT_SID).fetch();
    
    res.json({
      status: 'success',
      message: 'Twilio API test endpoint working',
      accountSid: 'configured',
      authToken: 'configured',
      accountStatus: account.status,
      accountType: account.type
    });
  } catch (error) {
    console.error('Twilio test error:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Twilio connection failed',
      error: error.message
    });
  }
});

// ==============================
// STRIPE PAYMENT ENDPOINTS
// ==============================

// Create Stripe checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { areaCode, priceId } = req.body;
    
    if (!areaCode) {
      return res.status(400).json({
        success: false,
        error: 'Area code is required'
      });
    }

    if (!priceId) {
      return res.status(400).json({
        success: false,
        error: 'Price ID is required'
      });
    }

    console.log('Creating Stripe checkout session for area code:', areaCode);

    // First check if numbers are available in this area code
    try {
      const availableNumbers = await twilioClient.availablePhoneNumbers('US').local.list({
        areaCode: areaCode,
        limit: 1
      });

      if (availableNumbers.length === 0) {
        return res.status(404).json({
          success: false,
          error: `No available numbers in area code ${areaCode}`
        });
      }
    } catch (twilioError) {
      console.error('Twilio availability check failed:', twilioError);
      return res.status(500).json({
        success: false,
        error: 'Failed to check number availability'
      });
    }

    // Create Stripe checkout session
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${FRONTEND_URL}/app?success=true&area_code=${areaCode}`,
      cancel_url: `${FRONTEND_URL}/app?canceled=true`,
      metadata: {
        areaCode: areaCode,
        service: 'phone_number_purchase',
        timestamp: new Date().toISOString()
      }
    });

    console.log('Stripe session created:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('Stripe session creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stripe webhook handler
app.post('/api/stripe/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe webhook received:', event.type);

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    handleSuccessfulPayment(session);
  }

  res.json({ received: true });
});

// Handle successful payment by purchasing Twilio number
async function handleSuccessfulPayment(session) {
  try {
    const areaCode = session.metadata.areaCode;
    console.log(`Processing successful payment for area code: ${areaCode}`);

    if (!areaCode) {
      console.error('No area code in session metadata');
      return;
    }

    // Search for available numbers
    const numbers = await twilioClient.availablePhoneNumbers('US').local.list({
      areaCode: areaCode,
      limit: 1
    });

    if (numbers.length === 0) {
      console.error(`No available numbers in area code ${areaCode} after payment`);
      // TODO: Handle this case - maybe refund or offer alternative
      return;
    }

    const selectedNumber = numbers[0];
    console.log('Purchasing number after payment:', selectedNumber.phoneNumber);
    
    // Purchase the number
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: selectedNumber.phoneNumber,
      voiceUrl: `${req.protocol}://${req.get('host')}/api/voice/webhook`,
      smsUrl: `${req.protocol}://${req.get('host')}/api/sms/webhook`,
      friendlyName: `Switchline ${areaCode} Number`
    });

    console.log('Number purchased successfully:', purchasedNumber.phoneNumber);
    
    // TODO: Store the number in database with customer information
    // TODO: Send confirmation email to admin@switchline.app
    
  } catch (error) {
    console.error('Error processing successful payment:', error);
    // TODO: Handle failed number purchase after successful payment
    // This should trigger an alert to admin@switchline.app
  }
}

// Get Stripe payment status
app.get('/api/stripe/payment-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripeClient.checkout.sessions.retrieve(sessionId);
    
    res.json({
      success: true,
      status: session.payment_status,
      areaCode: session.metadata.areaCode
    });
  } catch (error) {
    console.error('Error retrieving payment status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==============================
// TWILIO ENDPOINTS (Updated)
// ==============================

// Frontend-compatible purchase endpoint (now with payment validation)
app.post('/api/twilio/purchase-number', async (req, res) => {
  try {
    const { areaCode, paymentSessionId } = req.body;
    
    if (!areaCode) {
      return res.status(400).json({
        success: false,
        error: 'Area code is required'
      });
    }

    // If paymentSessionId is provided, validate payment first
    if (paymentSessionId) {
      try {
        const session = await stripeClient.checkout.sessions.retrieve(paymentSessionId);
        if (session.payment_status !== 'paid') {
          return res.status(402).json({
            success: false,
            error: 'Payment not completed'
          });
        }
      } catch (stripeError) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payment session'
        });
      }
    }

    console.log('Searching for numbers in area code:', areaCode);

    // Search for available numbers
    const numbers = await twilioClient.availablePhoneNumbers('US').local.list({
      areaCode: areaCode,
      limit: 1
    });

    if (numbers.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No available numbers in area code ${areaCode}`
      });
    }

    const selectedNumber = numbers[0];
    console.log('Purchasing number:', selectedNumber.phoneNumber);
    
    // Purchase the number
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: selectedNumber.phoneNumber,
      voiceUrl: `${req.protocol}://${req.get('host')}/api/voice/webhook`,
      smsUrl: `${req.protocol}://${req.get('host')}/api/sms/webhook`,
      friendlyName: `Switchline ${areaCode} Number`
    });

    res.json({
      success: true,
      phoneNumber: {
        sid: purchasedNumber.sid,
        phoneNumber: purchasedNumber.phoneNumber,
        friendlyName: purchasedNumber.friendlyName,
        status: purchasedNumber.status,
        dateCreated: purchasedNumber.dateCreated
      }
    });
  } catch (error) {
    console.error('Number purchase error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Frontend-compatible message endpoint
app.post('/api/twilio/send-message', async (req, res) => {
  try {
    const { from, to, message } = req.body;
    
    if (!from || !to || !message) {
      return res.status(400).json({
        success: false,
        error: 'From, to, and message are required'
      });
    }

    console.log('Sending SMS:', { from, to, message: message.substring(0, 50) + '...' });
    
    const sentMessage = await twilioClient.messages.create({
      body: message,
      from: from,
      to: to
    });

    res.json({
      success: true,
      message: {
        sid: sentMessage.sid,
        status: sentMessage.status,
        direction: sentMessage.direction,
        dateCreated: sentMessage.dateCreated
      }
    });
  } catch (error) {
    console.error('SMS send error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Frontend-compatible call endpoint
app.post('/api/twilio/make-call', async (req, res) => {
  try {
    const { from, to } = req.body;
    
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: 'From and to numbers are required'
      });
    }

    console.log('Making call:', { from, to });
    
    const call = await twilioClient.calls.create({
      from: from,
      to: to,
      url: `${req.protocol}://${req.get('host')}/api/voice/webhook`
    });

    res.json({
      success: true,
      call: {
        sid: call.sid,
        status: call.status,
        direction: call.direction,
        dateCreated: call.dateCreated
      }
    });
  } catch (error) {
    console.error('Call error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint - Number search (your working endpoint from September)
app.get('/debug', async (req, res) => {
  try {
    const areaCode = req.query.areaCode;
    console.log('Searching for numbers in area code:', areaCode);

    if (!areaCode) {
      return res.status(400).json({
        success: false,
        error: 'Area code parameter required'
      });
    }

    if (areaCode.length !== 3 || !/^\d{3}$/.test(areaCode)) {
      return res.status(400).json({
        success: false,
        error: 'Area code must be exactly 3 digits'
      });
    }

    const searchParams = {
      areaCode: areaCode,
      limit: 5
    };

    console.log('Twilio search params:', searchParams);
    const numbers = await twilioClient.availablePhoneNumbers('US').local.list(searchParams);
    
    console.log('Found numbers:', numbers.length);
    if (numbers.length > 0) {
      console.log('Sample number:', numbers[0].phoneNumber);
    }

    res.json({
      success: true,
      searchedAreaCode: areaCode,
      count: numbers.length,
      numbers: numbers.map(n => n.phoneNumber)
    });
  } catch (error) {
    console.error('Number search error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

// Alternative number search endpoint
app.get('/api/numbers/search', async (req, res) => {
  try {
    const { areaCode, limit = 5 } = req.query;
    
    if (!areaCode) {
      return res.status(400).json({
        error: 'Area code is required'
      });
    }

    const numbers = await twilioClient.availablePhoneNumbers('US').local.list({
      areaCode: areaCode,
      limit: parseInt(limit)
    });

    res.json({
      success: true,
      areaCode: areaCode,
      numbers: numbers.map(number => ({
        phoneNumber: number.phoneNumber,
        locality: number.locality,
        region: number.region,
        capabilities: number.capabilities
      }))
    });
  } catch (error) {
    console.error('Number search error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Number purchase endpoint (legacy)
app.post('/api/numbers/purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        error: 'Phone number is required'
      });
    }

    console.log('Purchasing number:', phoneNumber);
    
    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${req.protocol}://${req.get('host')}/api/voice/webhook`,
      smsUrl: `${req.protocol}://${req.get('host')}/api/sms/webhook`,
      friendlyName: 'Switchline Number'
    });

    res.json({
      success: true,
      number: {
        sid: purchasedNumber.sid,
        phoneNumber: purchasedNumber.phoneNumber,
        status: purchasedNumber.status,
        dateCreated: purchasedNumber.dateCreated
      }
    });
  } catch (error) {
    console.error('Number purchase error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// SMS sending endpoint
app.post('/api/messages/send', async (req, res) => {
  try {
    const { from, to, body } = req.body;
    
    if (!from || !to || !body) {
      return res.status(400).json({
        error: 'From, to, and body are required'
      });
    }

    console.log('Sending SMS:', { from, to, body: body.substring(0, 50) + '...' });
    
    const message = await twilioClient.messages.create({
      body: body,
      from: from,
      to: to
    });

    res.json({
      success: true,
      message: {
        sid: message.sid,
        status: message.status,
        direction: message.direction,
        dateCreated: message.dateCreated
      }
    });
  } catch (error) {
    console.error('SMS send error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Voice webhook endpoint
app.post('/api/voice/webhook', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  // Simple voice response - you can customize this
  twiml.say('Hello! This is your Switchline burner number. Please leave a message after the tone.');
  twiml.record({
    timeout: 10,
    transcribe: true,
    transcribeCallback: `/api/voice/transcription`
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// SMS webhook endpoint
app.post('/api/sms/webhook', (req, res) => {
  const { From, To, Body } = req.body;
  
  console.log('Received SMS:', { from: From, to: To, body: Body });
  
  // You can process incoming SMS here
  // For now, just acknowledge receipt
  
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml');
  res.send(twiml.toString());
});

// Voice transcription webhook
app.post('/api/voice/transcription', (req, res) => {
  const { TranscriptionText, CallSid, From, To } = req.body;
  
  console.log('Voice transcription:', {
    callSid: CallSid,
    from: From,
    to: To,
    transcription: TranscriptionText
  });
  
  res.status(200).send('OK');
});

// List purchased numbers
app.get('/api/numbers/list', async (req, res) => {
  try {
    const numbers = await twilioClient.incomingPhoneNumbers.list();
    
    res.json({
      success: true,
      numbers: numbers.map(number => ({
        sid: number.sid,
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName,
        status: number.status,
        dateCreated: number.dateCreated
      }))
    });
  } catch (error) {
    console.error('List numbers error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Delete/release a number
app.delete('/api/numbers/:sid', async (req, res) => {
  try {
    const { sid } = req.params;
    
    console.log('Releasing number with SID:', sid);
    
    await twilioClient.incomingPhoneNumbers(sid).remove();
    
    res.json({
      success: true,
      message: 'Number released successfully'
    });
  } catch (error) {
    console.error('Number release error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    services: {
      twilio: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN),
      stripe: !!STRIPE_SECRET_KEY
    },
    contactEmail: 'admin@switchline.app'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    contact: 'admin@switchline.app'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    contact: 'admin@switchline.app'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Switchline backend server running on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'configured' : 'missing'}`);
  console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'configured' : 'missing'}`);
  console.log(`Stripe Secret Key: ${STRIPE_SECRET_KEY ? 'configured' : 'missing'}`);
  console.log(`Contact Email: admin@switchline.app`);
  console.log(`Server URL: http://localhost:${PORT}`);
});

module.exports = app;

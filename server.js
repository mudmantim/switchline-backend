const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();

// Environment variables
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

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
    message: 'Switchline Backend API',
    version: '1.0.0',
    environment: NODE_ENV,
    timestamp: new Date().toISOString()
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
    const account = await client.api.accounts(TWILIO_ACCOUNT_SID).fetch();
    
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
    const numbers = await client.availablePhoneNumbers('US').local.list(searchParams);
    
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

    const numbers = await client.availablePhoneNumbers('US').local.list({
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

// Number purchase endpoint
app.post('/api/numbers/purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        error: 'Phone number is required'
      });
    }

    console.log('Purchasing number:', phoneNumber);
    
    const purchasedNumber = await client.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber,
      voiceUrl: `${req.protocol}://${req.get('host')}/api/voice/webhook`,
      smsUrl: `${req.protocol}://${req.get('host')}/api/sms/webhook`
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
    
    const message = await client.messages.create({
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
    const numbers = await client.incomingPhoneNumbers.list();
    
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
    
    await client.incomingPhoneNumbers(sid).remove();
    
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
    twilioConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Switchline backend server running on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'configured' : 'missing'}`);
  console.log(`Twilio Auth Token: ${TWILIO_AUTH_TOKEN ? 'configured' : 'missing'}`);
  console.log(`Server URL: http://localhost:${PORT}`);
});

module.exports = app;

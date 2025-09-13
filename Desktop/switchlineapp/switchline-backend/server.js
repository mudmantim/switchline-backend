const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3001;

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

// Validate Twilio credentials on startup
if (!accountSid || !authToken) {
  console.error('❌ CRITICAL: Missing Twilio credentials');
  console.error('Required environment variables:');
  console.error(`  TWILIO_ACCOUNT_SID: ${accountSid ? '✅ Set' : '❌ Missing'}`);
  console.error(`  TWILIO_AUTH_TOKEN: ${authToken ? '✅ Set' : '❌ Missing'}`);
  console.error('Server will start but Twilio features will be disabled.');
}

const client = twilio(accountSid, authToken);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Debug endpoint - test Twilio connection
app.get('/api/debug', async (req, res) => {
  try {
    // Check if Twilio credentials are configured
    if (!accountSid || !authToken) {
      console.log('❌ Twilio credentials not configured');
      return res.status(500).json({
        success: false,
        error: 'Twilio credentials not configured',
        details: {
          hasAccountSid: !!accountSid,
          hasAuthToken: !!authToken,
          environment: process.env.NODE_ENV || 'development'
        }
      });
    }

    // Validate Twilio client initialization
    if (!client || typeof client.availablePhoneNumbers !== 'function') {
      console.log('❌ Twilio client not properly initialized');
      return res.status(500).json({
        success: false,
        error: 'Twilio client initialization failed',
        details: {
          clientExists: !!client,
          accountSid: accountSid ? accountSid.substring(0, 10) + '...' : 'missing'
        }
      });
    }

    console.log('🔍 Testing Twilio connection...');

    const numbers = await client.availablePhoneNumbers('US')
      .local
      .list({ limit: 5 });

    console.log(`✅ Found ${numbers.length} numbers, First number: ${numbers[0]?.phoneNumber}`);

    res.json({
      success: true,
      message: 'Twilio connection working',
      availableNumbers: numbers.map(num => num.phoneNumber),
      accountSid: accountSid.substring(0, 10) + '...',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Twilio debug error:', error);

    // Enhanced error details for debugging
    const errorDetails = {
      message: error.message,
      code: error.code,
      status: error.status,
      moreInfo: error.moreInfo,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };

    // Specific error handling for common Twilio issues
    let statusCode = 500;
    let userMessage = error.message;

    if (error.code === 20003) {
      statusCode = 401;
      userMessage = 'Invalid Twilio credentials - check Account SID and Auth Token';
    } else if (error.code === 20404) {
      statusCode = 404;
      userMessage = 'Twilio resource not found';
    } else if (error.message && error.message.includes('ENOTFOUND')) {
      userMessage = 'Network error - cannot reach Twilio API';
    } else if (error.message && error.message.includes('timeout')) {
      userMessage = 'Timeout error - Twilio API request timed out';
    }

    res.status(statusCode).json({
      success: false,
      error: userMessage,
      details: errorDetails,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  }
});

// Search for available phone numbers
app.get('/api/numbers/search', async (req, res) => {
  try {
    const { areaCode } = req.query;
    
    if (!areaCode || areaCode.length !== 3) {
      return res.status(400).json({
        success: false,
        error: 'Valid 3-digit area code required'
      });
    }

    const numbers = await client.availablePhoneNumbers('US')
      .local
      .list({
        areaCode: areaCode,
        limit: 10
      });

    const availableNumbers = numbers.map(num => num.phoneNumber);
    
    res.json({
      success: true,
      availableNumbers: availableNumbers,
      areaCode: areaCode
    });

  } catch (error) {
    console.error('Number search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search for numbers'
    });
  }
});

// Purchase a phone number
app.post('/api/numbers/purchase', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    const purchasedNumber = await client.incomingPhoneNumbers.create({
      phoneNumber: phoneNumber
    });

    res.json({
      success: true,
      phoneNumber: purchasedNumber.phoneNumber,
      twilioSid: purchasedNumber.sid,
      message: 'Number purchased successfully'
    });

  } catch (error) {
    console.error('Number purchase error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to purchase number'
    });
  }
});

// Release/burn a phone number
app.delete('/api/numbers/:sid', async (req, res) => {
  try {
    const { sid } = req.params;
    
    await client.incomingPhoneNumbers(sid).remove();
    
    res.json({
      success: true,
      message: 'Number released successfully'
    });

  } catch (error) {
    console.error('Number release error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to release number'
    });
  }
});

// Make a phone call
app.post('/api/calls/make', async (req, res) => {
  try {
    const { to, from } = req.body;
    
    if (!to || !from) {
      return res.status(400).json({
        success: false,
        error: 'Both to and from numbers are required'
      });
    }

    const call = await client.calls.create({
      to: to,
      from: from,
      url: 'http://demo.twilio.com/docs/voice.xml'
    });

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      message: 'Call initiated successfully'
    });

  } catch (error) {
    console.error('Call error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to make call'
    });
  }
});

// Send SMS message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { to, body, from } = req.body;
    
    if (!to || !body || !from) {
      return res.status(400).json({
        success: false,
        error: 'To, from, and body are required'
      });
    }

    const message = await client.messages.create({
      body: body,
      from: from,
      to: to
    });

    res.json({
      success: true,
      messageSid: message.sid,
      status: message.status,
      message: 'Message sent successfully'
    });

  } catch (error) {
    console.error('Message error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send message'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Switchline Backend'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Twilio backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

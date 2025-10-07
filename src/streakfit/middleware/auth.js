const jwt = require('jsonwebtoken');

// Authentication middleware using HttpOnly cookies
function authenticateStreakFitToken(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: 'Authentication required. Please log in.' 
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      userId: decoded.userId,
      email: decoded.email
    };
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ 
        success: false,
        error: 'Session expired. Please log in again.',
        expired: true
      });
    }
    
    return res.status(403).json({ 
      success: false,
      error: 'Invalid authentication token. Please log in again.' 
    });
  }
}

// Optional authentication - doesn't fail if no token
function optionalAuth(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      userId: decoded.userId,
      email: decoded.email
    };
  } catch (error) {
    req.user = null;
  }
  
  next();
}

// Generate JWT token
function generateToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Set auth cookie
function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });
}

// Clear auth cookie
function clearAuthCookie(res) {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
}

module.exports = {
  authenticateStreakFitToken,
  optionalAuth,
  generateToken,
  setAuthCookie,
  clearAuthCookie
};

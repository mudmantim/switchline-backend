const bcrypt = require('bcrypt');
const db = require('../../shared/db');
const { generateToken, setAuthCookie, clearAuthCookie } = require('../middleware/auth');

// User signup
async function signup(req, res) {
  try {
    const { name, email, password } = req.body;

    // Validation
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

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    // Check if email already exists
    const existingUser = await db.query(
      'SELECT id FROM streakfit_users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered'
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create new user
    const userResult = await db.query(
      `INSERT INTO streakfit_users (name, email, password_hash, created_at) 
       VALUES ($1, $2, $3, NOW()) 
       RETURNING id, name, email, created_at`,
      [name.trim(), email.trim(), passwordHash]
    );

    const newUser = userResult.rows[0];

    // Create initial records for the user
    await db.query(
      `INSERT INTO streakfit_streaks (user_id, current_streak, longest_streak, total_calories, total_gold, total_xp, last_completed) 
       VALUES ($1, 0, 0, 0, 0, 0, NULL)`,
      [newUser.id]
    );

    await db.query(
      `INSERT INTO streakfit_user_progress (user_id, fitness_level, created_at, updated_at)
       VALUES ($1, NULL, NOW(), NOW())`,
      [newUser.id]
    );

    // Generate JWT token and set cookie
    const token = generateToken(newUser.id, newUser.email);
    setAuthCookie(res, token);

    res.status(201).json({
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
}

// User login
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user
    const userResult = await db.query(
      'SELECT id, name, email, password_hash FROM streakfit_users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const user = userResult.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Get user's streak data
    const streakResult = await db.query(
      'SELECT current_streak, longest_streak, total_calories, total_gold, total_xp FROM streakfit_streaks WHERE user_id = $1',
      [user.id]
    );

    // Get fitness level
    const progressResult = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [user.id]
    );

    // Generate JWT token and set cookie
    const token = generateToken(user.id, user.email);
    setAuthCookie(res, token);

    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        fitness_level: progressResult.rows[0]?.fitness_level || null
      },
      streak: streakResult.rows[0] || {
        current_streak: 0,
        longest_streak: 0,
        total_calories: 0,
        total_gold: 0,
        total_xp: 0
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
}

// User logout
async function logout(req, res) {
  try {
    clearAuthCookie(res);
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
}

// Get current user (check auth status)
async function getCurrentUser(req, res) {
  try {
    const userId = req.user.userId;

    const userResult = await db.query(
      'SELECT id, name, email, created_at FROM streakfit_users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const streakResult = await db.query(
      'SELECT current_streak, longest_streak, total_calories, total_gold, total_xp FROM streakfit_streaks WHERE user_id = $1',
      [userId]
    );

    const progressResult = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      user: {
        ...userResult.rows[0],
        fitness_level: progressResult.rows[0]?.fitness_level || null
      },
      streak: streakResult.rows[0] || {
        current_streak: 0,
        longest_streak: 0,
        total_calories: 0,
        total_gold: 0,
        total_xp: 0
      }
    });

  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user data'
    });
  }
}

// Get user stats by ID
async function getUserStats(req, res) {
  try {
    const { userId } = req.params;

    // Ensure user can only access their own data
    if (parseInt(userId) !== req.user.userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const userResult = await db.query(
      'SELECT id, name, email, created_at FROM streakfit_users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const streakResult = await db.query(
      'SELECT * FROM streakfit_streaks WHERE user_id = $1',
      [userId]
    );

    const challengesResult = await db.query(
      `SELECT * FROM streakfit_challenges 
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
        total_calories: 0,
        total_gold: 0,
        total_xp: 0
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
}

module.exports = {
  signup,
  login,
  logout,
  getCurrentUser,
  getUserStats
};

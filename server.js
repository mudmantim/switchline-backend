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

// ... [Keep all existing Switchline endpoints - around lines 300-1500] ...

// ============================================================================
// STREAKFIT ROUTES WITH AUTHENTICATION
// ============================================================================

// User signup with email/password
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

    // Create initial streak record
    await pool.query(
      `INSERT INTO streakfit_streaks (user_id, current_streak, longest_streak, total_calories, last_completed) 
       VALUES ($1, 0, 0, 0, NULL)`,
      [newUser.id]
    );

    // Create initial user progression record
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

// User login
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

// Generate 3 random popup challenges for a user
async function generateDailyPopups(userId) {
  try {
    // Delete any unfinished popups from previous days
    await pool.query(`
      DELETE FROM streakfit_popup_challenges 
      WHERE user_id = $1 AND completed_at IS NULL
    `, [userId]);

    // Get user's level to determine workout difficulty
    const userLevel = await pool.query(
      'SELECT level FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const level = userLevel.rows[0]?.level || 'beginner';
    
    // Select workout pool based on level
    let workoutPool;
    if (level === 'advanced') {
      workoutPool = ADVANCED_WORKOUTS;
    } else if (level === 'intermediate') {
      workoutPool = INTERMEDIATE_WORKOUTS;
    } else {
      workoutPool = BEGINNER_WORKOUTS;
    }

    // Randomly select 2 exercises and 1 trivia
    const selectedExercises = [];
    const usedIds = new Set();

    while (selectedExercises.length < 2) {
      const randomExercise = workoutPool[Math.floor(Math.random() * workoutPool.length)];
      if (!usedIds.has(randomExercise.id)) {
        selectedExercises.push(randomExercise);
        usedIds.add(randomExercise.id);
      }
    }

    // Get a random trivia question
    const triviaResult = await pool.query(`
      SELECT * FROM trivia_questions 
      ORDER BY RANDOM() 
      LIMIT 1
    `);

    const triviaQuestion = triviaResult.rows[0];

    // Generate 3 random times throughout the day (8 AM to 8 PM)
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

    // Create popup challenges
    const popups = [];

    // First exercise
    const popup1 = await pool.query(`
      INSERT INTO streakfit_popup_challenges 
      (user_id, challenge_type, challenge_data, scheduled_time, created_at)
      VALUES ($1, 'exercise', $2, $3, NOW())
      RETURNING *
    `, [userId, JSON.stringify(selectedExercises[0]), timeSlots[0]]);
    popups.push(popup1.rows[0]);

    // Trivia
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

    // Second exercise
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

// Get active popup challenge
app.get('/api/streakfit/active-popup', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Check if there are any popups for today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existingPopups = await pool.query(`
      SELECT COUNT(*) as count
      FROM streakfit_popup_challenges
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, today]);

    // Generate popups if none exist for today
    if (parseInt(existingPopups.rows[0].count) === 0) {
      await generateDailyPopups(userId);
    }

    // Get the next popup that should be shown
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

// Complete popup challenge
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

    // Get the popup
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

    // Calculate speed bonus (if completed in under 60 seconds, bonus increases)
    if (timeToComplete && timeToComplete < 60) {
      speedBonus = Math.floor((60 - timeToComplete) / 10) * 5; // 5 gems per 10 seconds under 60
    }

    if (popup.challenge_type === 'exercise') {
      const exercise = popup.challenge_data;
      goldEarned = exercise.gold;
      xpEarned = exercise.xp;
      gemsEarned = 10 + speedBonus; // Base 10 gems for completing popup exercise

    } else if (popup.challenge_type === 'trivia') {
      // Validate answer
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
          gemsEarned = speedBonus; // Only speed bonus if wrong
        }

        // Record trivia answer
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

    // Mark popup as completed
    await pool.query(`
      UPDATE streakfit_popup_challenges
      SET completed_at = NOW(),
          time_to_complete = $1,
          gems_earned = $2,
          speed_bonus = $3
      WHERE id = $4
    `, [timeToComplete, gemsEarned, speedBonus, popupId]);

    // Update user progression
    await pool.query(`
      UPDATE streakfit_user_progression
      SET total_gems = total_gems + $1,
          total_gold = total_gold + $2,
          total_xp = total_xp + $3
      WHERE user_id = $4
    `, [gemsEarned, goldEarned, xpEarned, userId]);

    // Check for level up
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

// Get user's popup history
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

// Get today's daily workout (4-5 exercises)
app.get('/api/streakfit/daily-workout', authenticateStreakFitToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user's level
    const userLevel = await pool.query(
      'SELECT level FROM streakfit_user_progression WHERE user_id = $1',
      [userId]
    );

    const level = userLevel.rows[0]?.level || 'beginner';
    
    // Select workout pool based on level
    let workoutPool;
    if (level === 'advanced') {
      workoutPool = ADVANCED_WORKOUTS;
    } else if (level === 'intermediate') {
      workoutPool = INTERMEDIATE_WORKOUTS;
    } else {
      workoutPool = BEGINNER_WORKOUTS;
    }

    // Generate seed based on today's date for consistency
    const today = new Date();
    const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    
    // Use seed to select same 5 exercises each time user checks today
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

    // Check which exercises have been completed today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const completedResult = await pool.query(`
      SELECT exercise_id FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedIds = new Set(completedResult.rows.map(r => r.exercise_id));

    // Mark exercises as completed
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

// Complete an exercise in daily workout
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

    // Find the exercise
    const exercise = ALL_WORKOUTS.find(w => w.id === exerciseId);

    if (!exercise) {
      return res.status(404).json({
        success: false,
        error: 'Exercise not found'
      });
    }

    // Check if already completed today
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

    // Record completion
    await pool.query(`
      INSERT INTO streakfit_workout_progress
      (user_id, exercise_id, exercise_name, gold_earned, xp_earned, completed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, exerciseId, exercise.name, exercise.gold, exercise.xp]);

    // Update user progression
    await pool.query(`
      UPDATE streakfit_user_progression
      SET total_gold = total_gold + $1,
          total_xp = total_xp + $2
      WHERE user_id = $3
    `, [exercise.gold, exercise.xp, userId]);

    // Check for level up
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

    // Check if all daily exercises completed (5 exercises)
    const completedTodayResult = await pool.query(`
      SELECT COUNT(*) as count FROM streakfit_workout_progress
      WHERE user_id = $1 AND completed_at >= $2
    `, [userId, todayStart]);

    const completedCount = parseInt(completedTodayResult.rows[0].count);
    const dailyWorkoutComplete = completedCount >= 5;

    // If daily workout complete, update streak
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

// Get user progression
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

    // Calculate XP needed for next level
    let xpForNextLevel = 0;
    if (progression.level === 'beginner') {
      xpForNextLevel = 1000;
    } else if (progression.level === 'intermediate') {
      xpForNextLevel = 3000;
    } else {
      xpForNextLevel = progression.total_xp; // Max level
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
// LEADERBOARD AND USER STATS
// ============================================================================

// Get leaderboard (authenticated)
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

// Get user stats (authenticated)
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
// TRIVIA ENDPOINTS (EXISTING - Keep as is)
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
        WHERE user_id = $${paramCount}
      )`;
      params.push(userId);
    }

    if (difficulty) {
      paramCount++;
      query += ` AND difficulty = $${paramCount}`;
      params.push(difficulty);
    }

    if (category) {
      paramCount++;
      query += ` AND category = $${paramCount}`;
      params.push(category);
    }

    if (age_group) {
      paramCount++;
      query += ` AND age_group = $${paramCount}`;
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
        resetQuery += ` AND difficulty = $${resetCount}`;
        resetParams.push(difficulty);
      }
      if (category) {
        resetCount++;
        resetQuery += ` AND category = $${resetCount}`;
        resetParams.push(category);
      }
      if (age_group) {
        resetCount++;
        resetQuery += ` AND age_group = $${resetCount}`;
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

// Database setup endpoint for StreakFit
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
// START SERVER (Keep existing Switchline endpoints before this)
// ============================================================================

app.listen(PORT, () => {
  console.log(`Switchline backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Dual-mode support enabled`);
  console.log(`🧪 Test endpoints available at /api/*/test-* routes`);
  console.log(`🔴 Production endpoints available with ?live=true parameter`);
  console.log(`🔥 StreakFit API available at /api/streakfit/* (AUTHENTICATED)`);
  console.log(`💪 StreakFit workout system with pop-ups enabled`);
});

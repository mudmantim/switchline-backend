const db = require('../../shared/db');
const { getDailyWorkout } = require('./workoutData');

// Generate 3 random pop-up challenges for a user's day
async function generateDailyPopups(userId) {
  try {
    // Check if user already has popups for today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const existing = await db.query(
      'SELECT COUNT(*) FROM streakfit_popup_challenges WHERE user_id = $1 AND scheduled_time >= $2',
      [userId, todayStart]
    );
    
    if (parseInt(existing.rows[0].count) >= 3) {
      return { 
        success: false, 
        message: 'Popups already generated for today' 
      };
    }
    
    // Get user's fitness level
    const userResult = await db.query(
      'SELECT fitness_level FROM streakfit_user_progress WHERE user_id = $1',
      [userId]
    );
    
    const fitnessLevel = userResult.rows[0]?.fitness_level || 'beginner';
    
    // Generate 3 random times throughout the day (9 AM - 9 PM)
    const times = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Morning (9-12), Afternoon (1-5), Evening (6-9)
    const timeSlots = [
      { start: 9, end: 12 },   // Morning
      { start: 13, end: 17 },  // Afternoon  
      { start: 18, end: 21 }   // Evening
    ];
    
    for (const slot of timeSlots) {
      const hour = slot.start + Math.floor(Math.random() * (slot.end - slot.start));
      const minute = Math.floor(Math.random() * 60);
      const scheduledTime = new Date(today);
      scheduledTime.setHours(hour, minute, 0, 0);
      times.push(scheduledTime);
    }
    
    // Create 3 challenges (2 exercise, 1 trivia)
    const challenges = [];
    
    // Challenge 1 & 2: Exercise
    const workouts = getDailyWorkout(fitnessLevel);
    for (let i = 0; i < 2; i++) {
      const randomWorkout = workouts[Math.floor(Math.random() * workouts.length)];
      
      challenges.push({
        challenge_type: 'exercise',
        challenge_data: randomWorkout,
        scheduled_time: times[i]
      });
    }
    
    // Challenge 3: Trivia
    const triviaResult = await db.query(`
      SELECT * FROM trivia_questions 
      WHERE id NOT IN (
        SELECT question_id FROM streakfit_trivia_answers WHERE user_id = $1
      )
      ORDER BY RANDOM() 
      LIMIT 1
    `, [userId]);
    
    let triviaQuestion;
    if (triviaResult.rows.length > 0) {
      triviaQuestion = triviaResult.rows[0];
    } else {
      // If all answered, pick any random question
      const anyTrivia = await db.query('SELECT * FROM trivia_questions ORDER BY RANDOM() LIMIT 1');
      triviaQuestion = anyTrivia.rows[0];
    }
    
    challenges.push({
      challenge_type: 'trivia',
      challenge_data: {
        id: triviaQuestion.id,
        question: triviaQuestion.question,
        options: triviaQuestion.options,
        category: triviaQuestion.category,
        difficulty: triviaQuestion.difficulty,
        gems_value: triviaQuestion.gems_value
      },
      scheduled_time: times[2]
    });
    
    // Insert all challenges
    for (const challenge of challenges) {
      await db.query(`
        INSERT INTO streakfit_popup_challenges 
        (user_id, challenge_type, challenge_data, scheduled_time, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [userId, challenge.challenge_type, JSON.stringify(challenge.challenge_data), challenge.scheduled_time]);
    }
    
    return { 
      success: true, 
      message: '3 popup challenges scheduled',
      challenges: challenges.map(c => ({
        type: c.challenge_type,
        scheduled: c.scheduled_time
      }))
    };
    
  } catch (error) {
    console.error('Generate popups error:', error);
    throw error;
  }
}

module.exports = {
  generateDailyPopups
};

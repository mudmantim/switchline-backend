const db = require('../../shared/db');
const { generateDailyPopups } = require('../services/popupService');

// Get active popup for user (if it's time)
async function getActivePopup(req, res) {
  try {
    const userId = req.user.userId;
    const now = new Date();
    
    // Find next scheduled popup that hasn't been opened yet
    const result = await db.query(`
      SELECT * FROM streakfit_popup_challenges
      WHERE user_id = $1 
      AND opened_at IS NULL
      AND scheduled_time <= $2
      ORDER BY scheduled_time ASC
      LIMIT 1
    `, [userId, now]);
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        hasActivePopup: false,
        message: 'No active popup challenges'
      });
    }
    
    const popup = result.rows[0];
    
    // Mark as opened
    await db.query(
      'UPDATE streakfit_popup_challenges SET opened_at = NOW() WHERE id = $1',
      [popup.id]
    );
    
    res.json({
      success: true,
      hasActivePopup: true,
      popup: {
        id: popup.id,
        type: popup.challenge_type,
        data: popup.challenge_data,
        scheduledTime: popup.scheduled_time,
        openedAt: new Date()
      }
    });
    
  } catch (error) {
    console.error('Get active popup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active popup'
    });
  }
}

// Complete a popup challenge
async function completePopup(req, res) {
  try {
    const { popupId, answer } = req.body;
    const userId = req.user.userId;
    
    if (!popupId) {
      return res.status(400).json({
        success: false,
        error: 'Popup ID required'
      });
    }
    
    // Get popup details
    const popupResult = await db.query(
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
    
    // Calculate time to complete (in seconds)
    const openedAt = new Date(popup.opened_at);
    const completedAt = new Date();
    const timeToComplete = Math.floor((completedAt - openedAt) / 1000);
    
    let gemsEarned = 0;
    let speedBonus = 0;
    let isCorrect = false;
    
    if (popup.challenge_type === 'trivia') {
      // Check trivia answer
      const triviaData = popup.challenge_data;
      const questionResult = await db.query(
        'SELECT correct_answer, gems_value FROM trivia_questions WHERE id = $1',
        [triviaData.id]
      );
      
      if (questionResult.rows.length > 0) {
        const correctAnswer = questionResult.rows[0].correct_answer;
        isCorrect = parseInt(answer) === correctAnswer;
        
        if (isCorrect) {
          gemsEarned = questionResult.rows[0].gems_value;
          
          // Speed bonus: answer in < 10 seconds = +50% gems
          if (timeToComplete < 10) {
            speedBonus = Math.floor(gemsEarned * 0.5);
            gemsEarned += speedBonus;
          }
          
          // Update user's total gems
          await db.query(`
            UPDATE streakfit_streaks 
            SET total_gems = COALESCE(total_gems, 0) + $1
            WHERE user_id = $2
          `, [gemsEarned, userId]);
        }
        
        // Record trivia answer
        await db.query(`
          INSERT INTO streakfit_trivia_answers 
          (user_id, question_id, answer_given, is_correct, gems_earned, answered_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id, question_id) DO NOTHING
        `, [userId, triviaData.id, answer, isCorrect, gemsEarned]);
      }
      
    } else {
      // Exercise challenge - always successful
      const exerciseData = popup.challenge_data;
      gemsEarned = Math.floor(exerciseData.gold / 2); // Convert gold to gems
      isCorrect = true;
      
      // Speed bonus for exercise: complete in < 60 seconds = +25% gems
      if (timeToComplete < 60) {
        speedBonus = Math.floor(gemsEarned * 0.25);
        gemsEarned += speedBonus;
      }
      
      // Update user's total gems
      await db.query(`
        UPDATE streakfit_streaks 
        SET total_gems = COALESCE(total_gems, 0) + $1
        WHERE user_id = $2
      `, [gemsEarned, userId]);
      
      // Record exercise completion
      await db.query(`
        INSERT INTO streakfit_workout_progress 
        (user_id, workout_id, workout_name, gold_earned, xp_earned, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [userId, exerciseData.id, exerciseData.name, exerciseData.gold, exerciseData.xp]);
    }
    
    // Update popup as completed
    await db.query(`
      UPDATE streakfit_popup_challenges 
      SET completed_at = NOW(), 
          time_to_complete = $1,
          gems_earned = $2,
          speed_bonus = $3
      WHERE id = $4
    `, [timeToComplete, gemsEarned, speedBonus, popupId]);
    
    res.json({
      success: true,
      completed: true,
      type: popup.challenge_type,
      correct: isCorrect,
      gemsEarned: gemsEarned,
      speedBonus: speedBonus,
      timeToComplete: timeToComplete
    });
    
  } catch (error) {
    console.error('Complete popup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete popup'
    });
  }
}

// Generate popups for user (call this once per day)
async function generatePopups(req, res) {
  try {
    const userId = req.user.userId;
    const result = await generateDailyPopups(userId);
    res.json(result);
  } catch (error) {
    console.error('Generate popups error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate popups'
    });
  }
}

// Get user's popup history
async function getHistory(req, res) {
  try {
    const userId = req.user.userId;
    
    const result = await db.query(`
      SELECT 
        id,
        challenge_type,
        challenge_data,
        scheduled_time,
        opened_at,
        completed_at,
        time_to_complete,
        gems_earned,
        speed_bonus
      FROM streakfit_popup_challenges
      WHERE user_id = $1
      ORDER BY scheduled_time DESC
      LIMIT 30
    `, [userId]);
    
    res.json({
      success: true,
      history: result.rows
    });
    
  } catch (error) {
    console.error('Get popup history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get popup history'
    });
  }
}

module.exports = {
  getActivePopup,
  completePopup,
  generatePopups,
  getHistory
};

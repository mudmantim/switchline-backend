const db = require('../../shared/db');

// Get a random trivia question (excludes already answered if authenticated)
async function getRandomQuestion(req, res) {
  try {
    const userId = req.user.userId;
    const { difficulty, category, age_group } = req.query;
    
    let query = 'SELECT * FROM trivia_questions WHERE 1=1';
    const params = [];
    let paramCount = 0;

    // Exclude already answered questions
    if (userId) {
      paramCount++;
      query += ` AND id NOT IN (
        SELECT question_id FROM streakfit_trivia_answers 
        WHERE user_id = $${paramCount}
      )`;
      params.push(userId);
    }

    // Optional filters
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

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      // If no unanswered questions, allow repeats
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
      const resetResult = await db.query(resetQuery, resetParams);
      
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
}

// Submit trivia answer and get result with explanation
async function submitAnswer(req, res) {
  try {
    const { questionId, answer } = req.body;
    const userId = req.user.userId;

    if (questionId === undefined || answer === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Question ID and answer are required'
      });
    }

    const result = await db.query(
      'SELECT correct_answer, explanation, gems_value, category, difficulty FROM trivia_questions WHERE id = $1',
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

    // Record the answer
    await db.query(`
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

    // Update user's total gems if correct
    if (isCorrect) {
      await db.query(`
        UPDATE streakfit_streaks 
        SET total_gems = COALESCE(total_gems, 0) + $1
        WHERE user_id = $2
      `, [gemsEarned, userId]);
    }

    res.json({
      success: true,
      correct: isCorrect,
      correctAnswer: question.correct_answer,
      explanation: question.explanation,
      gemsEarned: gemsEarned,
      category: question.category,
      difficulty: question.difficulty
    });

  } catch (error) {
    console.error('Submit trivia answer error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit answer'
    });
  }
}

// Get trivia categories and counts
async function getCategories(req, res) {
  try {
    const result = await db.query(`
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
}

// Get user's trivia statistics
async function getStats(req, res) {
  try {
    const userId = req.user.userId;

    // Overall stats
    const statsResult = await db.query(`
      SELECT 
        COUNT(*) as total_answered,
        COUNT(*) FILTER (WHERE is_correct = true) as correct_count,
        SUM(gems_earned) as total_gems
      FROM streakfit_trivia_answers
      WHERE user_id = $1
    `, [userId]);

    // Stats by category
    const categoryStats = await db.query(`
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

    // Stats by difficulty
    const difficultyStats = await db.query(`
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

    // Recent answers
    const recentAnswers = await db.query(`
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
}

module.exports = {
  getRandomQuestion,
  submitAnswer,
  getCategories,
  getStats
};

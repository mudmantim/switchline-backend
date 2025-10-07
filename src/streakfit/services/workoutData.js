// Workout data organized by fitness level

const BEGINNER_WORKOUTS = [
  { id: 1, name: "Jumping Jacks", emoji: "🤸", reps: 20, gold: 10, xp: 15, category: "cardio" },
  { id: 2, name: "Wall Push-ups", emoji: "💪", reps: 10, gold: 15, xp: 20, category: "strength" },
  { id: 3, name: "Bodyweight Squats", emoji: "🦵", reps: 15, gold: 12, xp: 18, category: "strength" },
  { id: 4, name: "Knee Push-ups", emoji: "💪", reps: 8, gold: 12, xp: 18, category: "strength" },
  { id: 5, name: "Standing Calf Raises", emoji: "🦿", reps: 20, gold: 8, xp: 12, category: "strength" },
  { id: 6, name: "Arm Circles", emoji: "💫", reps: 30, gold: 8, xp: 12, category: "warmup" },
  { id: 7, name: "Marching in Place", emoji: "🚶", duration: 60, gold: 10, xp: 15, category: "cardio" },
  { id: 8, name: "Seated Toe Touches", emoji: "🧘", reps: 10, gold: 8, xp: 12, category: "flexibility" },
  { id: 9, name: "Chair Dips", emoji: "🪑", reps: 8, gold: 15, xp: 20, category: "strength" },
  { id: 10, name: "Side Leg Raises", emoji: "🦵", reps: 12, gold: 10, xp: 15, category: "strength" }
];

const INTERMEDIATE_WORKOUTS = [
  { id: 11, name: "Burpees", emoji: "💥", reps: 10, gold: 25, xp: 35, category: "cardio" },
  { id: 12, name: "Push-ups", emoji: "💪", reps: 15, gold: 20, xp: 30, category: "strength" },
  { id: 13, name: "Jump Squats", emoji: "🦘", reps: 15, gold: 22, xp: 32, category: "strength" },
  { id: 14, name: "Mountain Climbers", emoji: "⛰️", reps: 20, gold: 20, xp: 30, category: "cardio" },
  { id: 15, name: "Lunges", emoji: "🦵", reps: 20, gold: 18, xp: 28, category: "strength" },
  { id: 16, name: "Plank Hold", emoji: "🏋️", duration: 45, gold: 25, xp: 35, category: "core" },
  { id: 17, name: "High Knees", emoji: "🏃", duration: 45, gold: 18, xp: 28, category: "cardio" },
  { id: 18, name: "Diamond Push-ups", emoji: "💎", reps: 10, gold: 25, xp: 35, category: "strength" },
  { id: 19, name: "Russian Twists", emoji: "🌀", reps: 30, gold: 20, xp: 30, category: "core" },
  { id: 20, name: "Box Jumps", emoji: "📦", reps: 12, gold: 28, xp: 38, category: "strength" }
];

const ADVANCED_WORKOUTS = [
  { id: 21, name: "One-Arm Push-ups", emoji: "💪", reps: 8, gold: 40, xp: 55, category: "strength" },
  { id: 22, name: "Pistol Squats", emoji: "🎯", reps: 10, gold: 45, xp: 60, category: "strength" },
  { id: 23, name: "Handstand Push-ups", emoji: "🤸", reps: 5, gold: 50, xp: 70, category: "strength" },
  { id: 24, name: "Burpee Pull-ups", emoji: "🔥", reps: 10, gold: 45, xp: 60, category: "cardio" },
  { id: 25, name: "Muscle-ups", emoji: "💥", reps: 5, gold: 55, xp: 75, category: "strength" },
  { id: 26, name: "Dragon Flags", emoji: "🐉", reps: 8, gold: 50, xp: 70, category: "core" },
  { id: 27, name: "Clapping Push-ups", emoji: "👏", reps: 12, gold: 40, xp: 55, category: "strength" },
  { id: 28, name: "L-Sit Hold", emoji: "🏋️", duration: 30, gold: 45, xp: 60, category: "core" },
  { id: 29, name: "Archer Push-ups", emoji: "🏹", reps: 10, gold: 42, xp: 57, category: "strength" },
  { id: 30, name: "Box Jump Overs", emoji: "📦", reps: 15, gold: 38, xp: 52, category: "cardio" }
];

const ALL_WORKOUTS = [...BEGINNER_WORKOUTS, ...INTERMEDIATE_WORKOUTS, ...ADVANCED_WORKOUTS];

// Helper function to get workouts by level
function getWorkoutsByLevel(level) {
  switch(level) {
    case 'beginner':
      return BEGINNER_WORKOUTS;
    case 'intermediate':
      return INTERMEDIATE_WORKOUTS;
    case 'advanced':
      return ADVANCED_WORKOUTS;
    default:
      return BEGINNER_WORKOUTS;
  }
}

// Helper function to get workout by ID
function getWorkoutById(id) {
  return ALL_WORKOUTS.find(w => w.id === id);
}

// Generate daily workout based on date seed
function getDailyWorkout(fitnessLevel, date = new Date()) {
  const workoutPool = getWorkoutsByLevel(fitnessLevel);
  const today = date.toISOString().split('T')[0];
  const seed = today.split('-').join('');
  
  // Generate 4 or 5 exercises consistently for this day
  const exerciseCount = 4 + (parseInt(seed.slice(-1)) % 2);
  
  const selectedIndices = new Set();
  let attempts = 0;
  while (selectedIndices.size < exerciseCount && attempts < 100) {
    const index = (parseInt(seed) + selectedIndices.size * 7 + attempts) % workoutPool.length;
    selectedIndices.add(index);
    attempts++;
  }
  
  const dailyExercises = Array.from(selectedIndices).map(index => workoutPool[index]);
  return dailyExercises;
}

module.exports = {
  BEGINNER_WORKOUTS,
  INTERMEDIATE_WORKOUTS,
  ADVANCED_WORKOUTS,
  ALL_WORKOUTS,
  getWorkoutsByLevel,
  getWorkoutById,
  getDailyWorkout
};

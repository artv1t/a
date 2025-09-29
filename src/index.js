
const dotenv = require('dotenv');
dotenv.config();

console.log('🎯 SalonSniper Starting...');
console.log('📁 Project structure created');
console.log('⚙️  Configuration loaded');
console.log('📋 Ready for Step 2: Helius Listener implementation');


process.on('SIGTERM', () => {
  console.log('🛑 Graceful shutdown initiated');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Graceful shutdown initiated');
  process.exit(0);
});

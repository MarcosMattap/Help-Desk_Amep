const fs = require('fs');

const code = fs.readFileSync('src/server.js', 'utf8');
let lines = code.split('\n');

console.log('Looking at GET /admin route (line 338)...\n');
let braceBalance = 0;
let parenBalance = 0;

for (let i = 337; i < Math.min(400, lines.length); i++) {
  const line = lines[i];
  const braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  const parenCount = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
  
  braceBalance += braceCount;
  parenBalance += parenCount;
  
  if (braceCount !== 0 || parenCount !== 0 || i === 384) {
    console.log(`Line ${i+1}: balance=${braceBalance} braces, ${parenBalance} parens: ${line.slice(0, 100)}`);
  }
}

console.log(`\n✅ At end of route: ${braceBalance} braces, ${parenBalance} parens`);

// Now check globally what's not balanced at line 338
console.log('\n\nSearching backwards from line 338 to find what\'s unclosed...');

braceBalance = 0;
parenBalance = 0;

for (let i = 0; i < 338; i++) {
  const line = lines[i];
  const braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  const parenCount = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
  
  braceBalance += braceCount;
  parenBalance += parenCount;
}

console.log(`Before line 338: ${braceBalance} unclosed braces, ${parenBalance} unclosed parens`);

// Check specifically at line 337
if (braceBalance !== 0 || parenBalance !== 0) {
  console.log('\nIssue BEFORE line 338. Looking for the cause...');
  
  let b = 0, p = 0;
  for (let i = 0; i < 338; i++) {
    const line = lines[i];
    const braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    const parenCount = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    
    b += braceCount;
    p += parenCount;
    
    if (b > 0 && i > 60) {
      console.log(`Line ${i+1}: accumulated to ${b} braces, ${p} parens: ${line.slice(0, 100)}`);
      b = 0;
      p = 0;
    }
  }
}

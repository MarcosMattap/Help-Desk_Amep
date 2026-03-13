const fs = require('fs');

const lines = fs.readFileSync('src/server.js', 'utf8').split('\n');

// Lines 338-386 (0-indexed: 337-385)
const routeLines = lines.slice(337, 386);

let braceCounts = { open: 0, close: 0 };
let parenCounts = { open: 0, close: 0 };

for (const line of routeLines) {
  let inString = false;
  let stringChar = null;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prev = j > 0 ? line[j-1] : '';
    const next = j < line.length - 1 ? line[j+1] : '';
    
    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
      continue;
    }
    
    if (inString && char === stringChar && prev !== '\\') {
      inString = false;
      continue;
    }
    
    if (inString) continue;
    
    // Skip comments
    if (char === '/' && next === '/') break;
    
    if (char === '{') braceCounts.open++;
    else if (char === '}') braceCounts.close++;
    else if (char === '(') parenCounts.open++;
    else if (char === ')') parenCounts.close++;
  }
}

console.log('Inside GET /admin route (lines 338-386):');
console.log(`Braces: ${braceCounts.open} open, ${braceCounts.close} close (balance: ${braceCounts.open - braceCounts.close})`);
console.log(`Parens: ${parenCounts.open} open, ${parenCounts.close} close (balance: ${parenCounts.open - parenCounts.close})`);

// Now analyze which lines contribute to the imbalance
console.log('\n\nLine-by-line breakdown:');

let b = 0, p = 0;
routeLines.forEach((line, idx) => {
  let bOpen = 0, bClose = 0, pOpen = 0, pClose = 0;
  let inString = false;
  let stringChar = null;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prev = j > 0 ? line[j-1] : '';
    const next = j < line.length - 1 ? line[j+1] : '';
    
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
      continue;
    }
    
    if (inString && char === stringChar && prev !== '\\') {
      inString = false;
      continue;
    }
    
    if (inString) continue;
    
    if (char === '/' && next === '/') break;
    
    if (char === '{') bOpen++;
    else if (char === '}') bClose++;
    else if (char === '(') pOpen++;
    else if (char === ')') pClose++;
  }
  
  b += bOpen - bClose;
  p += pOpen - pClose;
  
  if (bOpen !== bClose || pOpen !== pClose) {
    console.log(`Line ${338 + idx}: {${bOpen}-${bClose}=${bOpen-bClose}} (${p}), (${pOpen}-${pClose}=${pOpen-pClose}) (${p}): ${line.slice(0, 80)}`);
  }
});

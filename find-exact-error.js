const fs = require('fs');

const code = fs.readFileSync('src/server.js', 'utf8');
let lines = code.split('\n');

let openBraces = [];
let openParens = [];
let lastUnmatchedLine = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
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
    
    if (char === '{') {
      openBraces.push(i + 1);
      lastUnmatchedLine = i + 1;
    } else if (char === '}') {
      if (openBraces.length > 0) {
        openBraces.pop();
      }
    } else if (char === '(') {
      openParens.push(i + 1);
      lastUnmatchedLine = i + 1;
    } else if (char === ')') {
      if (openParens.length > 0) {
        openParens.pop();
      }
    }
  }
}

console.log(`Unclosed braces at lines: ${openBraces.join(', ')}`);
console.log(`Unclosed parens at lines: ${openParens.join(', ')}`);

if (openBraces.length > 0 || openParens.length > 0) {
  console.log(`\nContext for first unclosed:  `);
  const firstLine = Math.min(...[...openBraces, ...openParens]);
  for (let i = Math.max(0, firstLine - 3); i < Math.min(lines.length, firstLine + 3); i++) {
    const marker = i + 1 === firstLine ? '>>> ' : '    ';
    const content = lines[i].slice(0, 120);
    console.log(`${marker}${i + 1}: ${content}`);
  }
}

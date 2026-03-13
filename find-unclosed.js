const fs = require('fs');

const code = fs.readFileSync('src/server.js', 'utf8');
let lines = code.split('\n');
let braceStack = [];
let parenStack = [];
let braceCount = 0;
let parenCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inString = false;
  let stringChar = null;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prevChar = j > 0 ? line[j-1] : '';
    const nextChar = j < line.length - 1 ? line[j+1] : '';
    
    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
      continue;
    }
    
    if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = null;
      continue;
    }
    
    if (inString) continue;
    
    // Skip comments
    if (char === '/' && nextChar === '/') break;
    
    if (char === '{') {
      braceCount++;
      braceStack.push(i + 1);
    } else if (char === '}') {
      braceCount--;
      braceStack.pop();
    } else if (char === '(') {
      parenCount++;
      parenStack.push(i + 1);
    } else if (char === ')') {
      parenCount--;
      parenStack.pop();
    }
  }
}

console.log(`Final: Braces: ${braceCount}, Parens: ${parenCount}`);

if (braceCount > 0) {
  console.log(`\n❌ ${braceCount} unclosed brace(s) at line(s):`);
  braceStack.forEach(line => console.log(`   Line ${line}`));
}

if (parenCount > 0) {
  console.log(`\n❌ ${parenCount} unclosed paren(s) at line(s):`);
  parenStack.forEach(line => console.log(`   Line ${line}`));
}

// Show context around unclosed items
if (braceStack.length > 0) {
  const lineNum = braceStack[0];
  console.log(`\nContext at line ${lineNum}:`);
  console.log(lines[lineNum - 1]);
}

if (parenStack.length > 0) {
  const lineNum = parenStack[0];
  console.log(`\nContext at line ${lineNum}:`);
  console.log(lines[lineNum - 1]);
}

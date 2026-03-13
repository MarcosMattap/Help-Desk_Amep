const fs = require('fs');

const code = fs.readFileSync('src/server.js', 'utf8');
let braceCount = 0;
let parenCount = 0;
let bracketCount = 0;
let lines = code.split('\n');
let problemLine = null;
let problemChar = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prevChar = j > 0 ? line[j-1] : '';
    const nextChar = j < line.length - 1 ? line[j+1] : '';
    
    // Skip comments
    if (char === '/' && nextChar === '/') break;
    if (char === '/' && nextChar === '*') {
      // Skip block comment
      while (j < line.length && !(line[j] === '*' && line[j+1] === '/')) j++;
      j += 2;
      continue;
    }
    
    // Skip strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      j++;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++;
        j++;
      }
      continue;
    }
    
    if (char === '{') {
      braceCount++;
    }
    if (char === '}') {
      braceCount--;
      if (braceCount < 0) {
        problemLine = i + 1;
        problemChar = '{/}';
      }
    }
    if (char === '(') {
      parenCount++;
    }
    if (char === ')') {
      parenCount--;
      if (parenCount < 0) {
        problemLine = i + 1;
        problemChar = '(/}';
      }
    }
    if (char === '[') bracketCount++;
    if (char === ']') {
      bracketCount--;
      if (bracketCount < 0) {
        problemLine = i + 1;
        problemChar = '[/]';
      }
    }
  }
}

console.log(`Braces: ${braceCount}, Parens: ${parenCount}, Brackets: ${bracketCount}`);
if (problemLine) {
  console.log(`Problem at line ${problemLine}: ${problemChar}`);
}
if (braceCount !== 0 || parenCount !== 0 || bracketCount !== 0) {
  console.log('❌ UNBALANCED!');
  // Find first line with brace or paren issues
  console.log('\nSearching for unmatched opening delimiters...');
  braceCount = 0;
  parenCount = 0;
  let stack = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Simple check - count on each line
    const braces = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    const parens = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    
    if (braces > 0 || parens > 0) {
      console.log(`Line ${i + 1}: +${braces} braces, +${parens} parens: ${line.slice(0, 80)}`);
    }
  }
  
  process.exit(1);
} else {
  console.log('✅ All balanced!');
}

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: c42trans <input_file> -o <output_file>')
  .command('$0 <input_file>', 'Translate a C file', (yargs) => {
    yargs.positional('input_file', {
      describe: 'The C input file to process',
      type: 'string',
    });
  })
  .option('o', {
    alias: 'output',
    demandOption: true,
    describe: 'The C output file destination',
    type: 'string',
  })
  .fail((msg, err, yargs) => {
    // Custom error handling matching your original output style
    if (msg) console.error(`Error: ${msg}\n`);
    console.error(yargs.help());
    process.exit(1);
  })
  .argv;

// Validate input file existence
if (!fs.existsSync(argv.input_file)) {
  console.error(`Error: Input file "${inputFile}" does not exist.`);
  process.exit(1);
}

// Load configurations
let c42Opts = { pointer: { nonNullSyntax: false, nullableSyntax: false } };
const configPath = path.join(process.cwd(), 'c42.json');

if (fs.existsSync(configPath)) {
  try {
    c42Opts = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.warn("Warning: Failed to parse c42.json, using strict defaults.");
  }
}

module.exports = { argv, c42Opts };
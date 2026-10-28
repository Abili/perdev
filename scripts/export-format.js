// Writes training/perdev_format.json: the exact tool specs, output truncation
// limit and system prompt template the extension uses at runtime, so the
// training data matches what the model will see. Run after `npm run compile`.
const fs = require('fs');
const path = require('path');
const { TOOL_SPECS, MAX_OUTPUT, NO_OUTPUT_NOTE } = require('../out/toolSpecs');
const { systemPrompt } = require('../out/prompt');

const out = path.join(__dirname, '..', 'training', 'perdev_format.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      tools: TOOL_SPECS,
      max_output: MAX_OUTPUT,
      no_output_note: NO_OUTPUT_NOTE,
      // Placeholders are filled per example by the dataset builder.
      system_prompt_template: systemPrompt('{root}', { platform: '{platform}', release: '{release}', date: '{date}', shell: '{shell}' }),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${out}`);

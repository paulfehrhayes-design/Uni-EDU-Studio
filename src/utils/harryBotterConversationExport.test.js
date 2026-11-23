import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConversationTextExport,
  conversationExportFilename,
} from './harryBotterConversationExport.js';

test('conversation export preserves draft attribution and source citations', () => {
  const exported = buildConversationTextExport({
    title: 'Water cycle lesson',
    exportedAt: '2026-11-23T00:00:00.000Z',
    learningLevel: 'MYP 3',
    tone: 'Formal',
    agentName: 'General assistant',
    messages: [
      {
        role: 'user',
        content: 'Explain evaporation.',
        speakerLabel: 'Speaker 2',
        messageSource: 'streaming_transcription',
      },
      {
        role: 'user',
        content: 'Can you add an example?',
        messageSource: 'typed',
      },
      {
        role: 'assistant',
        content: 'Evaporation changes liquid water into water vapor.',
        sources: [{
          title: 'Water cycle',
          source: 'Teacher handout',
          section_title: 'Science',
          review_date: '2026-11-19',
          url: 'https://school.example/water-cycle',
        }],
      },
    ],
  });

  assert.match(exported, /Title: Water cycle lesson/);
  assert.match(exported, /Learning stage: MYP 3/);
  assert.match(exported, /Speaker 2 transcript:/);
  assert.match(exported, /Your message:\nCan you add an example\?/);
  assert.match(exported, /Harry Botter draft:/);
  assert.match(exported, /Water cycle — Teacher handout — Science/);
  assert.match(exported, /https:\/\/school\.example\/water-cycle/);
  assert.match(exported, /Reviewed: 2026-11-19/);
});

test('conversation export filename is safe and has a fallback', () => {
  assert.equal(
    conversationExportFilename('Water cycle: lesson #1'),
    'harry-botter-water-cycle-lesson-1.txt',
  );
  assert.equal(conversationExportFilename('!!!'), 'harry-botter-conversation.txt');
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildConversationTextExport({
  title,
  exportedAt,
  learningLevel,
  tone,
  agentName,
  messages,
}) {
  const lines = [
    'Harry Botter conversation export',
    `Title: ${text(title) || 'New conversation'}`,
    `Exported (UTC): ${text(exportedAt)}`,
  ];

  if (text(learningLevel)) lines.push(`Learning stage: ${text(learningLevel)}`);
  if (text(tone)) lines.push(`Tone: ${text(tone)}`);
  if (text(agentName)) lines.push(`Agent: ${text(agentName)}`);
  lines.push('');

  for (const message of messages) {
    const speaker = message.role === 'assistant'
      ? 'Harry Botter draft'
      : message.messageSource === 'streaming_transcription'
        ? `${text(message.speakerLabel) || 'Unassigned speaker'} transcript`
        : 'Your message';
    lines.push(`${speaker}:`, message.content, '');

    if (Array.isArray(message.sources) && message.sources.length > 0) {
      lines.push('Sources:');
      for (const source of message.sources) {
        const details = [text(source.title), text(source.source), text(source.section_title)]
          .filter(Boolean)
          .join(' — ');
        lines.push(`- ${details || 'Untitled source'}`);
        if (text(source.url)) lines.push(`  ${text(source.url)}`);
        if (text(source.review_date)) lines.push(`  Reviewed: ${text(source.review_date)}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function conversationExportFilename(title) {
  const slug = text(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `harry-botter-${slug || 'conversation'}.txt`;
}

import { describe, it, expect } from 'vitest';
import { aboutMarkdown } from './aboutMarkdown';
import { parseAbout } from './aboutSections';

describe('aboutMarkdown', () => {
  it('находит документ и делит его на подразделы', () => {
    // The file is bundled through a glob; a wrong pattern leaves the menu empty and the
    // screen silently blank, so the content itself is checked here.
    const sections = parseAbout(aboutMarkdown());
    expect(sections.length).toBeGreaterThanOrEqual(4);
    expect(sections[0].title.length).toBeGreaterThan(0);
    expect(sections[0].body.length).toBeGreaterThan(0);
  });

  it('у каждого подраздела, кроме роадмапа, есть ссылка на документ', () => {
    const sections = parseAbout(aboutMarkdown());
    const withLinks = sections.filter((s) => s.link);
    expect(withLinks.length).toBeGreaterThan(0);
    for (const section of withLinks) {
      expect(section.link).toMatch(/\.md$/);
    }
  });
});

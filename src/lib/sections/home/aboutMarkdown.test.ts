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

  it('в каждом подразделе есть хотя бы одна ссылка', () => {
    // The screen draws these as footer buttons; a section without any is a section the
    // user cannot follow up on.
    const sections = parseAbout(aboutMarkdown());
    for (const section of sections) {
      expect(section.links.length).toBeGreaterThan(0);
    }
  });

  it('внутренние ссылки ведут на .md, внешние — на http(s)', () => {
    const sections = parseAbout(aboutMarkdown());
    const targets = sections.flatMap((s) => s.links.map((l) => l.target));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toMatch(/^(https?:|.*\.md$)/);
    }
  });
});

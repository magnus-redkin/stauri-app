import { describe, it, expect } from 'vitest';
import { parseAbout, sectionId, resolveDocPath, docUrl } from './aboutSections';

describe('parseAbout', () => {
  it('делит файл по ## и оставляет ### внутри', () => {
    const md = [
      '## First',
      '',
      'Body one.',
      '',
      '### Detail',
      '',
      'Deeper text.',
      '',
      '## Second',
      '',
      'Body two.',
    ].join('\n');

    const sections = parseAbout(md);
    expect(sections.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(sections[0].body).toContain('### Detail');
    expect(sections[0].body).toContain('Deeper text.');
    expect(sections[1].body).toBe('Body two.');
  });

  it('вынимает ссылку внизу подраздела из текста', () => {
    // The screen draws it as a button, so it must not also render as a paragraph.
    const md = ['## Topic', '', 'Some text.', '', '[Full document](ru/web3im.md)'].join('\n');
    const [section] = parseAbout(md);
    expect(section.links).toEqual([
      { label: 'Full document', target: 'ru/web3im.md' },
    ]);
    expect(section.body).toBe('Some text.');
    expect(section.body).not.toContain('Full document');
  });

  it('берёт несколько ссылок внизу в порядке файла', () => {
    // A section points at its own document and at an outside source.
    const md = [
      '## Topic',
      '',
      'Some text.',
      '',
      '[Full document](web3im.md)',
      '[Status](https://status.im)',
    ].join('\n');
    const [section] = parseAbout(md);
    expect(section.links).toEqual([
      { label: 'Full document', target: 'web3im.md' },
      { label: 'Status', target: 'https://status.im' },
    ]);
    expect(section.body).toBe('Some text.');
  });

  it('не трогает ссылку в середине текста', () => {
    const md = ['## Topic', '', 'See [the doc](en/architecture.md) for details.', '', 'More.'].join('\n');
    const [section] = parseAbout(md);
    expect(section.links).toEqual([]);
    expect(section.body).toContain('[the doc]');
  });

  it('игнорирует текст до первого заголовка', () => {
    // A page title or a note to translators is not a subsection.
    const md = ['# Title', '', 'Intro.', '', '## Topic', '', 'Body.'].join('\n');
    const sections = parseAbout(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Topic');
  });

  it('даёт разные id одинаковым заголовкам', () => {
    const md = ['## Same', 'a', '## Same', 'b'].join('\n');
    const sections = parseAbout(md);
    expect(sections.map((s) => s.id)).toEqual(['same', 'same-2']);
  });

  it('переживает CRLF и пустой файл', () => {
    expect(parseAbout('## A\r\n\r\ntext\r\n')).toEqual([
      { id: 'a', title: 'A', body: 'text', links: [] },
    ]);
    expect(parseAbout('')).toEqual([]);
  });
});

describe('sectionId', () => {
  it('делает читаемый слаг из любого алфавита', () => {
    expect(sectionId('What is Web3 IM?')).toBe('what-is-web3-im');
    expect(sectionId('Что такое Web3 IM?')).toBe('что-такое-web3-im');
    expect(sectionId('Stauri vs Status.im')).toBe('stauri-vs-status-im');
    expect(sectionId('!!!')).toBe('section');
  });
});

describe('resolveDocPath', () => {
  it('берёт путь относительно языка страницы', () => {
    expect(resolveDocPath('web3im.md', 'ru')).toBe('docs/ru/web3im.md');
  });

  it('уважает явный язык в ссылке', () => {
    // An English page may point at the comparison document that exists only in Russian.
    expect(resolveDocPath('ru/comparison.md', 'en')).toBe('docs/ru/comparison.md');
  });

  it('отказывается выходить за docs', () => {
    expect(resolveDocPath('../secrets.md', 'ru')).toBe('');
    expect(resolveDocPath('/etc/passwd', 'ru')).toBe('');
  });
});

describe('docUrl', () => {
  it('строит адрес для окна dApp', () => {
    expect(docUrl('docs/en/architecture.md')).toBe(
      'https://github.com/magnus-redkin/stauri-app/blob/main/docs/en/architecture.md'
    );
    expect(docUrl('')).toBe('');
  });
});

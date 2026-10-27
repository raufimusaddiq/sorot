import { isValidElement } from 'react';
import RootLayout, { metadata } from '../layout';
import StudioLayout, { metadata as studioMeta } from '../studio/layout';

describe('RootLayout', () => {
  it('wraps children in <html lang="id"><body>', () => {
    const tree = RootLayout({ children: <p>hi</p> });
    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe('html');
    expect(tree.props.lang).toBe('id');
    const body = tree.props.children;
    expect(body.type).toBe('body');
    expect(body.props.className).toContain('font-sans');
  });

  it('exports page metadata', () => {
    expect(metadata.title).toEqual({ default: 'Sorot: 90 minutes in, 40 seconds out', template: '%s · Sorot' });
    expect(metadata.openGraph).toMatchObject({ siteName: 'Sorot' });
    expect(String(metadata.metadataBase)).toBe('http://localhost:8080/');
  });

  it('the studio is titled and passes its page through', () => {
    expect(studioMeta.title).toBe('Studio');
    const child = <p>x</p>;
    expect(StudioLayout({ children: child })).toBe(child);
  });
});

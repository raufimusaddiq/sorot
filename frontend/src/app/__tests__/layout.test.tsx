import { isValidElement } from 'react';
import RootLayout, { metadata } from '../layout';

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
    expect(metadata.title).toBe('Viral Clipper');
  });
});

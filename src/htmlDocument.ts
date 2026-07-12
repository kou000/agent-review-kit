import * as path from 'path';
import { ReviewPaths } from './paths';
import { loadDocumentIndex } from './store';
import { HtmlDocumentMeta } from './types';

// Document ids become file names (documents/<id>.html) and URL segments
// (/doc/<id>), so keep them to a safe slug shape. Same policy as snapshot ids:
// validate before any path or href use.
export const DOCUMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function documentHtmlPath(paths: ReviewPaths, id: string): string {
  return path.join(paths.documentsDir, `${id}.html`);
}

export function findDocument(paths: ReviewPaths, id: string): HtmlDocumentMeta | null {
  if (!DOCUMENT_ID_RE.test(id)) return null;
  return (
    loadDocumentIndex(paths.documentsIndex).documents.find((d) => d.id === id) ?? null
  );
}

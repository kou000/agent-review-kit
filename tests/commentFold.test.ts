import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMENT_FOLD_MAX_PX,
  COMMENT_FOLD_SLACK_PX,
  commentFoldToggle,
  shouldFoldComment,
} from '../src/client/commentFold';

test('folds to 400px (about 20 lines) and only once 60px more would be hidden', () => {
  assert.equal(COMMENT_FOLD_MAX_PX, 400);
  assert.equal(COMMENT_FOLD_SLACK_PX, 60);
});

test('short comments are not folded', () => {
  assert.equal(shouldFoldComment(36), false);
  assert.equal(shouldFoldComment(COMMENT_FOLD_MAX_PX), false);
});

test('a comment just over the fold height is shown in full rather than hiding a few lines', () => {
  const limit = COMMENT_FOLD_MAX_PX + COMMENT_FOLD_SLACK_PX;
  assert.equal(shouldFoldComment(COMMENT_FOLD_MAX_PX + 1), false);
  assert.equal(shouldFoldComment(limit), false);
  assert.equal(shouldFoldComment(limit + 1), true);
});

test('a long pasted output (e.g. ~700 lines of terraform plan) is folded', () => {
  // 700 lines of a code block at the diff page's 20px line-height.
  assert.equal(shouldFoldComment(700 * 20), true);
});

test('an element that is not rendered (display: none) is never folded', () => {
  assert.equal(shouldFoldComment(0), false);
  assert.equal(shouldFoldComment(NaN), false);
});

test('the toggle offers to expand while folded and to fold again once expanded', () => {
  assert.equal(commentFoldToggle(false).label, '続きを表示');
  assert.equal(commentFoldToggle(true).label, '折りたたむ');
});

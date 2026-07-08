# agent-review-kit

Claude Code のメインセッションと人間レビュアーをつなぐ、ローカル差分レビューツール。

エージェントが修正後にレビュー用HTMLを生成し、ユーザーはブラウザで GitHub の PR レビューのように差分へインラインコメント（行範囲選択対応）を書く。エージェントは `wait-comments` でコメントを受け取り、**同じセッションのまま**回答・修正・resolve を繰り返す。

```
Claude Code セッション                     ブラウザ (http://localhost:<実ポート>)
──────────────────────                    ─────────────────────────────
generate  ──► .agent-review/review.html ──►  side-by-side 差分表示
serve     ──► ローカルサーバー起動        ◄──  行/行範囲を選択してコメント
wait-comments ◄── comments.json ◄──────────  POST /api/comments
（コメントを読んで修正・回答）
resolve-comment ──► 状態更新 ─────────────►  画面に agent の返信が表示される
```

## 特徴

- **共通ツール**: 各プロジェクトには組み込まず、どの git リポジトリでも `agent-review-kit generate` するだけで使える。データはそのリポジトリの `.agent-review/` に置かれる。
- **同一セッション処理**: コメントごとに別プロセスの Claude Code を起動しない。Skill の手順として `wait-comments` を実行し、受け取ったコメントを同じセッションが処理する。
- **GitHub ライクな UI**: side-by-side 差分、追加/削除/コンテキスト行の色分け、行番号クリックで単一行コメント、Shift+クリックまたはドラッグで行範囲コメント、インラインのコメントスレッド表示、未解決数バッジ。
- **依存ゼロのランタイム**: サーバーは Node.js 標準ライブラリのみで動く。

## インストール

```bash
git clone <this-repo> agent-review-kit
cd agent-review-kit
npm install
npm run build
npm link        # グローバルに agent-review-kit コマンドを提供
```

`npm link` の代わりに、任意のプロジェクトから `node /path/to/agent-review-kit/dist/cli.js` で直接呼んでもよい。

## 開発

```bash
npm run dev -- generate        # tsx で src/cli.ts を直接実行
npm run typecheck              # 型チェック
npm run lint                   # ESLint
npm run build                  # dist/ にビルド（client 資産のコピーを含む）
```

## 使い方

すべてのコマンドは、レビュー対象の git リポジトリのルートで実行する。

### 1. レビューHTMLの生成

```bash
agent-review-kit generate              # working tree vs HEAD の差分
agent-review-kit generate --base main  # main と working tree の差分
```

- `.agent-review/review.html`（+ `app.js` / `style.css`）を生成する。
- `.agent-review/comments.json` を初期化する（既存コメントがあれば保持する）。
- `.agent-review/state.json` に base と生成時刻を記録する。

再実行するとHTMLだけが更新され、コメントは保持される。ブラウザは生成時刻の変化を検知して自動リロードする。

### 2. サーバー起動

```bash
agent-review-kit serve                 # 5179 から空きポートを自動選択し .agent-review/server.json に記録
agent-review-kit serve --port 8080
```

API:

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/comments` | 全コメント取得 |
| POST | `/api/comments` | コメント作成 |
| PATCH | `/api/comments/:id` | body / status の更新 |
| POST | `/api/comments/:id/resolve` | status を `resolved` にする |
| GET | `/api/status` | 集計（未解決数・状態別件数・生成時刻） |

`POST /api/comments` は通常 `file` / `side` / `startLine`〜`endLine` / `startDiffLine`〜`endDiffLine` / `body` を送るが、`file` を省略（または `null`）して `body` だけを送ると、特定の行に紐づかない**全体コメント**（レビュー全体への指摘・質問）として登録される。この場合 `file` / `side` / 各行番号は `null` になる。画面上部の「全体コメント」セクションから投稿・閲覧できる。

既存コメントへの**返信**は `parentId`（返信元コメントの `id`）と `body` を送る。返信のアンカー（`file` / `side` / `startLine`〜`endLine` / `startDiffLine`〜`endDiffLine`）は**親コメントからコピー**され、リクエストの位置情報は無視される（返信が親からずれない）。存在しない `parentId` を指定すると 400 になる。返信への返信を送った場合、`parentId` はそのスレッドの**トップレベルの親**に正規化され、スレッドは常に1段ネストで保持される。画面上では返信が親コメントの直下にインデント表示される。

### 3. コメント待機（エージェント用）

```bash
agent-review-kit wait-comments --timeout 0     # 無期限に待つ
agent-review-kit wait-comments --timeout 600   # 最大600秒待つ
```

`status: open` のコメントが現れると、それらを `seen` に更新して stdout に返す:

```json
{ "status": "received", "comments": [ { "id": "comment_xxx", "file": "src/example.ts", "side": "new", "startLine": 10, "endLine": 15, "body": "..." } ] }
```

タイムアウト時:

```json
{ "status": "timeout", "comments": [] }
```

### 4. コメントへの対応を記録（エージェント用)

```bash
agent-review-kit resolve-comment comment_xxx --status fixed --message "nullチェックを追加しました"
agent-review-kit resolve-comment comment_xxx --status answered --message "この値はAPI側で検証済みです"
```

status: `open` / `seen` / `fixed` / `answered` / `wontfix` / `resolved`。
`--message` は `agentResponse` としてコメントに保存され、画面にインライン表示される。

### 5. 状態確認

```bash
agent-review-kit status
```

```json
{
  "total": 3,
  "unresolved": 1,
  "counts": { "open": 0, "seen": 1, "fixed": 1, "answered": 0, "wontfix": 0, "resolved": 1 },
  "base": "main",
  "generatedAt": "2026-07-08T05:00:00.000Z"
}
```

`unresolved` は `open + seen` の件数。

## Skill として使う（Claude Code）

`skills/my-interactive-review/SKILL.md` にレビューループの手順が定義されている。Claude Code から使えるようにするには、ユーザースキルとしてリンクする:

```bash
ln -s /path/to/agent-review-kit/skills/my-interactive-review ~/.claude/skills/my-interactive-review
```

以降、Claude Code セッションで `/my-interactive-review` を実行すると、エージェントが

1. `generate` でレビューHTMLを生成し、`serve` を起動し、
2. ユーザーにブラウザレビューを依頼して `wait-comments --timeout 0` で待ち、
3. コメントを受けたら同一セッションで回答（`answered`）または修正+テスト（`fixed`）し、
4. `generate` を再実行してHTMLを更新し、未解決0件までループする。

既存の自作スキル（例: `/my-feature`, `/my-auto-bugfix-tb`）の最終ステップから「修正完了後は my-interactive-review スキルの手順でレビューを受ける」と参照させると、実装 → セルフレビュー → 人間レビューのループが一本につながる。

## コメントのデータ形式

`.agent-review/comments.json`:

```json
{
  "comments": [
    {
      "id": "comment_xxx",
      "file": "src/example.ts",
      "side": "new",
      "startLine": 10,
      "endLine": 15,
      "startDiffLine": 120,
      "endDiffLine": 125,
      "body": "ここはnullチェックが必要では？",
      "status": "fixed",
      "createdAt": "2026-07-08T05:00:00.000Z",
      "updatedAt": "2026-07-08T05:10:00.000Z",
      "agentResponse": {
        "message": "nullチェックを追加しました",
        "updatedAt": "2026-07-08T05:10:00.000Z"
      }
    }
  ]
}
```

- `side`: `new` = 変更後の行、`old` = 変更前（削除側）の行
- `startLine` / `endLine`: 対象ファイル内の行番号（範囲コメント対応）
- `startDiffLine` / `endDiffLine`: `git diff` 出力上の行番号（差分内の位置の一意な参照）
- **全体コメント**（レビュー全体への指摘・質問）は `file` / `side` / `startLine` / `endLine` / `startDiffLine` / `endDiffLine` がすべて `null`。`body` のみを持ち、画面上部の「全体コメント」セクションに表示される。
- `parentId`: 返信元コメントの `id`（省略または `null` はトップレベルコメント）。返信のアンカーは親からコピーされ、`parentId` は常にトップレベルの親を指す（スレッドは1段ネスト）。返信は画面上で親コメントの直下にネスト表示される。

## 例: 一連の流れ

```bash
cd my-project
vim src/example.ts                          # 何か修正する

agent-review-kit generate
agent-review-kit serve &                    # 実ポートは .agent-review/server.json を参照
agent-review-kit wait-comments --timeout 0  # ブラウザでコメントを書くとここが返る
# → {"status":"received","comments":[{"id":"comment_abc", ...}]}

# 修正して…
agent-review-kit resolve-comment comment_abc --status fixed --message "対応しました"
agent-review-kit generate                   # HTMLを更新（ブラウザは自動リロード）
agent-review-kit status                     # unresolved が 0 なら完了
```

## 制約・注意

- 未追跡（untracked）ファイルは `git diff` に現れないため、レビュー対象にするには `git add -N <file>` などで意図的に追跡させる。
- サーバーは localhost 向けのローカル開発ツールであり、認証はない。外部公開しないこと。
- 差分を再生成して行がずれたコメントは、画面下部の「現在の差分に位置づけできないコメント」に退避表示される。

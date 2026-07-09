---
name: my-interactive-review
description: 修正完了後に agent-review-kit でレビューHTMLを生成し、ユーザーがブラウザで書いた差分コメントを同一セッションで受け取り、回答・修正・resolve を未解決0件まで繰り返すレビューループ。Use when the user wants to review changes in a browser (GitHub-like diff review) and iterate on fixes with inline comments.
---

# my-interactive-review

agent-review-kit を使って、ユーザーとブラウザ経由のレビューループを回すためのスキル。
このスキルを実行しているメインセッションは**受付とオーケストレーションに徹する**: コメントを待ち、読み、トリアージし、質問に回答し、修正結果を検証して resolve する。**コード修正そのものはサブエージェントに委譲する**（「修正の委譲」参照）。
**コメントごとに別の Claude Code プロセスを起動してはならない。**

## 前提

- `agent-review-kit` コマンドが使えること（グローバルインストール済み、または `npx agent-review-kit`）。
- 対象プロジェクトの作業ディレクトリ（git リポジトリ）で実行すること。`.agent-review/` がそこに作られる。

## 手順

1. 修正が完了したら、レビューHTMLを生成する。

   ```bash
   agent-review-kit generate
   ```

   ブランチ全体をレビュー対象にする場合は、比較先ブランチ名をそのまま指定せず merge-base を base にする:

   ```bash
   BASE_REF=$(git merge-base main HEAD)
   agent-review-kit generate --base "$BASE_REF"
   ```

   `agent-review-kit generate --base main` は `main...HEAD` ではなく `main..現在のworking tree` 相当になり、現在ブランチに未取り込みの `main` 側変更が逆向きの差分として混ざることがある。未コミット差分だけをレビュー対象にする場合は、base を指定せず `agent-review-kit generate` を使う。

2. serve を起動する。ポートは固定ではなく、`.agent-review/server.json` に記録された実ポートを使う。

   まず、このプロジェクトの serve が既に生きているか確認する。`server.json` があり、そのポートの `/api/status` が返す `projectDir` が現在のプロジェクトディレクトリと一致すれば起動済み:

   ```bash
   PORT=$(node -p "String(require('./.agent-review/server.json').port)" 2>/dev/null)
   [ -n "$PORT" ] && curl -s "http://localhost:$PORT/api/status" | grep -F "\"projectDir\": \"$(pwd)\""
   # → マッチすれば起動済み。それ以外（server.json なし・curl 失敗・projectDir 不一致）は未起動扱い
   ```

   （`jq` はこの環境にない前提。`node -p` の数値出力は色コードが混ざることがあるため `String()` で包む）

   未起動なら、serve をバックグラウンドで起動する。ポートは 5179 から空きを自動選択して `server.json` に記録される。起動後に `server.json` を読み直して実ポートを取得する。

   **注意: `projectDir` の一致確認を省略しない。** 別プロジェクトの serve が同じポートで生きていると、curl が成功してしまい、ユーザーが別プロジェクトの diff にコメントを書く事故になる。

3. ユーザーに「http://localhost:<実ポート> を開いてレビューしてください」と伝える（`<実ポート>` は `server.json` の値）。
   行番号クリックで単一行コメント、Shift+クリックまたはドラッグで行範囲コメントができることも添える。

4. コメントを待つ。このコマンドは新規コメントが来るまでブロックする:

   ```bash
   agent-review-kit wait-comments --timeout 0
   ```

   受信すると `{"status": "received", "comments": [...]}` が stdout に返り、該当コメントは `seen` になる。

5. 受け取った各コメントを読む。`file` / `side` / `startLine`〜`endLine` / `body` を確認する。
   - `file: null` のコメントは特定の行ではなくレビュー全体への指摘・質問（`side` / 各行番号も null）。
   - 行範囲コメント（startLine ≠ endLine）の場合は、範囲全体のコードを読んで指摘の意図を解釈する。1行だけ見て対応しない。
   - `side: "old"` は変更前（削除側）の行に対するコメント。削除やリファクタへの指摘であることが多い。
   - `parentId` を持つコメントは既存コメントへの返信。親コメント・その `agentResponse`・同じスレッドの他の返信を含むスレッド全体を読んで文脈を解釈すること（agent の回答への追撃質問であることが多い）。返信のアンカー（file/side/各行番号）は親からコピーされ、`parentId` は常にトップレベルの親を指す（スレッドは1段ネスト）。
   - 対応前に `git diff` で現在の変更状態を確認する。

6. コメントが**質問**なら、コードを調査して回答をまとめ、次で返す:

   ```bash
   agent-review-kit resolve-comment <id> --status answered --message "回答内容"
   ```

7. コメントが**修正指摘**なら、メインセッションは自分でコードを編集せず、**サブエージェントに委譲する**（1件だけでも委譲する。方針は「修正の委譲」）。サブエージェントの変更を取り込み、**メイン側で**テストまたは型チェックが通ることを確認したら、**その修正を1コミットとしてコミットし**、その sha を `--commit` で添えて resolve する:

   ```bash
   git commit -am "fix: <対応内容>"          # 1指摘=1コミットを推奨（差分を単独で見せられる）
   agent-review-kit resolve-comment <id> --status fixed --message "対応内容の説明" --commit "$(git rev-parse HEAD)"
   ```

   `--commit` を付けると返信にコミットリンク（🔗 短縮sha）が表示され、ユーザーがクリックするとそのコミットの差分だけを新しいタブで確認できる（GitHub 不要・ローカル完結）。`--commit` には `--message` が必須。テスト・型チェックの実行は必須で、失敗したまま fixed にしない。

8. 対応すべきか**判断できない**場合は、理由を書いて返す:

   ```bash
   agent-review-kit resolve-comment <id> --status answered --message "判断できない理由と選択肢"
   ```

   対応しない判断をユーザーと合意済みの場合は `--status wontfix` を使う。

9. コードを修正した場合は、レビューHTMLを再生成する（コメントは保持される）:

   ```bash
   agent-review-kit generate
   ```

   `--base` を省略しても前回 generate の base が引き継がれるので、ブランチ全体レビューの再生成でもそのまま実行してよい。ブラウザ側は自動でリロードされる。

10. 現在の状態を確認する:

    ```bash
    agent-review-kit status
    ```

    `unresolved`（open + seen）が未解決コメント数。

11. 未解決コメントが残っている、またはユーザーのレビューが続いている間は、手順4の `wait-comments` に戻る。

12. 未解決コメントが 0 になり、ユーザーがレビュー完了を示したら、対応内容をまとめて完了報告する。

## 修正の委譲

メインセッションは受付・トリアージ・回答・取り込み・検証・resolve・generate に集中し、コード修正そのものは**コメント1件でもサブエージェントに委譲する**。

- サブエージェントのモデルは**セッションより軽いモデルを相対指定**する（特定のモデル名をスキルにハードコードしない）。設計判断をともなう大きな修正だけ、セッションと同等のモデルを使ってよい。
- 一度に複数コメントを受け取った場合は「対応で触るファイル・領域」でグルーピングする。同じファイルを触るコメント群は1つのサブエージェントにまとめて渡し、グループ間は並列実行する。
- 並列実行するサブエージェントは **git worktree で隔離**する（Claude Code の Agent ツールなら `isolation: "worktree"`）。同一 working tree 上での並列編集はしない。サブエージェントが1体だけならメインの working tree を直接編集させてよいが、その実行中に新たな修正コメントが来て追加のサブエージェントを起動する場合、後発は worktree で隔離する。
- 各サブエージェントには、担当コメントの全文・対象ファイル・検証コマンド（型チェック/テスト）を明示し、検証まで通させ、変更内容（worktree の場合はそのパスまたはブランチ）を報告させる。
- 完了後、メインセッションが変更をメインの working tree に取り込む。**コンフリクトしたらその時点でメインセッションが解決する**（並列化を諦める理由にしない）。
- `resolve-comment --status fixed` は、変更をメインに取り込み、**メイン側で型チェック/テストが通ってから**実行する。worktree 内で通っただけでは fixed にしない。
- 全グループの取り込みが終わったら `generate` を再実行してレビューHTMLを更新する。

## 注意

- コメントごとに別プロセスの Claude Code を起動しない。このセッションがループの主体。受信・トリアージ・回答・resolve はメインセッションが行い、コード修正はサブエージェントが行う。
- 修正前に必ず現在の git diff を確認し、修正後に必ずテストまたは型チェックを実行する。
- `wait-comments --timeout 0` は**常にバックグラウンドで常駐させる**。サブエージェントの完了待ちの間もコメント受信を止めない。受信して返ってきたら（内容のトリアージ後に）すぐ再度バックグラウンドで起動し直し、レビュー中は監視が途切れないようにする。
- 受信したら即トリアージする: 質問はサブエージェントの完了を待たずメインセッションがその場で回答（`answered`）し、実装が必要なものは「修正の委譲」の方針に従って委譲またはキューイングする。
- レビュー対象の diff を変えたい場合（例: コミット後に base を変える）は `generate --base <ref>` を再実行する。

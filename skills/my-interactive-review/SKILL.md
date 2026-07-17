---
name: my-interactive-review
description: 修正完了後に agent-review-kit でレビューHTMLを生成し、ユーザーがブラウザで書いた差分コメントを同一セッションで受け取り、回答・修正・resolve を未解決0件まで繰り返すレビューループ。AIレビューの指摘を add-comment でブラウザ上のコメントとして表示し、ユーザーが返信した指摘だけ修正する「AIレビューモード」も含む。実装プラン・設計書などの任意HTMLを publish-html でレンダリング済みのまま表示し、要素クリック・テキスト範囲でコメントを受け取る「HTMLレビューモード」も含む。他のレビュースキルの結果の出力先として agent-review-kit が指定された場合も、このスキルを読んで AI レビューモードの手順に従うこと。Use when the user wants to review changes in a browser (GitHub-like diff review), review a rendered HTML doc (plan/design doc) in a browser, iterate on fixes with inline comments, or display AI review findings as browser comments (output target: agent-review-kit).
---

# my-interactive-review

agent-review-kit を使って、ユーザーとブラウザ経由のレビューループを回すためのスキル。
このスキルを実行しているメインセッションは**受付とオーケストレーションに徹する**: コメントを待ち、読み、トリアージし、質問に回答し、修正結果を検証して resolve する。**コード修正そのものはサブエージェントに委譲する**（「修正の委譲」参照）。
**コメントごとに別の Claude Code プロセスを起動してはならない。**

## 前提

- `agent-review-kit` コマンドが使えること。このスキルは agent-review-kit リポジトリに同梱されているため、基本はそのローカルクローンの CLI を使う（`node <repo>/dist/cli.js <command>`）。グローバルインストール済みなら `agent-review-kit` で直接呼べる。npm 未公開のため `npx agent-review-kit` は使えない。
- 対象プロジェクトの作業ディレクトリ（git リポジトリ）で実行すること。`.agent-review/` がそこに作られる。

## 設定（settings）の扱い

設定はユーザーがブラウザの歯車メニューから**レビュー中いつでも切り替えられる**。現在の設定は `wait-comments` の受信出力（`received`）に**毎回同乗してくる**ので、**そのバッチの処理はその `settings` に従う**。別途 `status` で確認しにいく必要はない（受信より前に把握したい場合のみ `agent-review-kit status` を使う）:

- `settings.readOnlyMode: true` — **読み取り専用モード**。他人の MR を閲覧するだけのレビューなど、コードを変更してはいけないモード。修正指摘が来ても**コードを変更せず**、調査結果・修正案を `--status answered` で回答するだけにする。サブエージェント委譲もしない。**received の settings を見ずに修正へ進むことを禁止する。**
- `settings.snapshotsEnabled: false` — 修正スナップショット（後述）を保存しない設定。`snapshot create` は `{"status":"skipped"}` を返すので、コマンド手順は変えなくてよい（`resolve-comment` に `--snapshot` を付けないだけ）。

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

   受信すると `{"status": "received", "settings": {...}, "comments": [...]}` が stdout に返り、該当コメントは `seen` になる。`settings` は受信時点の設定で、**このバッチの処理方針はここに従う**（「設定（settings）の扱い」参照）。

   ユーザーがブラウザの「レビュー終了」ボタンを押すと `{"status": "finished", "comments": []}` が返る。この場合はループを抜けて手順12の完了報告に進む（AI指摘の見送り処理とサーバー停止はサーバー側で完了済み。wait-comments の再起動もしない）。

   **最初の wait-comments を起動する前に、取りこぼしを回収する。** `agent-review-kit status` の `counts.seen` が 0 でなければ、前回セッションが受信したまま対応せずに終わったコメントが残っている（`seen` は wait-comments では二度と配達されない）。`.agent-review/comments.json` から `status: "seen"` のコメントを読み、通常の受信分と同じように手順5以降でトリアージする。

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

7. コメントが**修正指摘**なら、まず**そのバッチの `received.settings.readOnlyMode`** を確認する（true なら修正せず、修正案を `answered` で回答する）。修正する場合、メインセッションは自分でコードを編集せず、**サブエージェントに委譲する**（1件だけでも委譲する。方針は「修正の委譲」）。

   **修正はコミットせず、スナップショットとして記録する。** git 履歴を汚さずに「この指摘に対する修正だけ」の差分ページをユーザーに見せられる。流れ:

   ```bash
   # (1) サブエージェントの変更をメイン working tree に取り込む【直前】に、現状を記録
   agent-review-kit snapshot begin

   # (2) 変更を取り込み、メイン側で型チェック/テストを通す

   # (3) この修正の patch を保存し、スナップショット id を得る
   agent-review-kit snapshot create --comment <コメントid> --title "対応内容の短い説明"
   # → {"status":"created","snapshot":{"id":"snap_xxx",...}}

   # (4) スナップショットリンク付きで resolve する
   agent-review-kit resolve-comment <コメントid> --status fixed --message "対応内容の説明" --snapshot snap_xxx
   ```

   `--snapshot` を付けると返信に「📄 修正差分」リンクが表示され、ユーザーがクリックするとその修正だけの差分を新しいタブで確認できる（コミット不要・ローカル完結）。`--snapshot` には `--message` が必須。テスト・型チェックの実行は必須で、失敗したまま fixed にしない。

   - サブエージェントが worktree 内で**コミット済み**の場合は、begin/create の代わりに `snapshot create --comment <id> --commit <そのsha>` でそのコミットの差分を patch として取り込める（worktree のコミットは共有 object DB 経由で解決される）。
   - `snapshot create` が `{"status":"skipped"}` を返したら設定でスナップショットが OFF。`--snapshot` を付けずに resolve する。
   - **メインブランチへのコミットはユーザーが明示的に指示した時だけ行う**（粒度は「コミット指示への対応」参照）。

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

12. 次のいずれかでループを終了し、対応内容をまとめて完了報告する:
    - `wait-comments` が `{"status":"finished"}` を返した（ユーザーがブラウザの「レビュー終了」ボタンを押した）
    - `unresolved` が 0 になり、ユーザーが会話でレビュー完了を示した

    コミットの指示があればここで対応する（「コミット指示への対応」参照）。

## コミット指示への対応

レビュー中の修正は working tree に未コミットのまま蓄積されている。ユーザーからコミットの指示を受けたら、指定された粒度でコミットする:

- **まとめて1コミット**: 現在の working tree をそのままコミットするだけ。
- **コメント単位でコミットを分ける**: `.agent-review/snapshots/` の patch を時系列（ファイル名の連番）順に再生する。各 patch は「その時点の working tree」を前提に作られているため、**先に最初の `snapshot begin` 時点の状態（`index.json` の `baselineTree`）を復元してから**再生する。レビュー開始時に未コミット変更があった場合、この復元を飛ばすと patch #1 が適用できない:

  ```bash
  # (0) 最終状態を tree として記録してから退避（安全ネット兼、再生後の検証基準。
  #     stash@{0} との diff は untracked ファイルが stash^3 に分かれて正しく比較
  #     できないため、必ずこの tree と比較する）
  git add -A && FINAL_TREE=$(git write-tree)
  git stash -u

  # (1) ベースライン（最初の snapshot begin 時点）を復元する。
  #     HEAD と一致していれば diff は空で、このコミットはスキップされる
  BASE_TREE=$(node -p 'JSON.parse(require("fs").readFileSync(".agent-review/snapshots/index.json")).baselineTree')
  git diff HEAD "$BASE_TREE" > /tmp/ark-baseline.patch
  if [ -s /tmp/ark-baseline.patch ]; then
    git apply --index /tmp/ark-baseline.patch
    git commit -m "wip: レビュー開始時点の変更"   # メッセージ・扱いはユーザーに確認
  fi

  # (2) 連番順に、patch 適用 → コミット を繰り返す
  for p in .agent-review/snapshots/0*.patch; do
    git apply --index "$p"
    git commit -m "fix: <index.json の該当エントリの title / commentId から要約>"
  done

  git diff "$FINAL_TREE"           # 空なら再生完了（最終状態を完全再現）。退避を破棄:
  git stash drop
  ```

  `git diff "$FINAL_TREE"` に差分が残る場合、それはスナップショットの外で行われた変更（手動編集など）。その差分を最後の別コミットにするかユーザーに確認する。patch 適用が失敗した場合は `git apply --3way --index` を試し、それでも駄目なら `git reset --hard HEAD` 後に `git stash pop` で元に戻してから状況を報告する。ベースラインのコミットを履歴に残したくない場合は、再生後に rebase 等での整理をユーザーと相談する。

## AI レビューモード

ユーザーが「AI にレビューさせたい」「まず自分（エージェント）でレビューして」と指示した場合の変形モード。ループの仕組み（serve / wait-comments / resolve / generate）は通常と同一で、**ループ開始前に自分が diff をレビューして指摘をコメントとして投稿する**前段だけが追加される。

1. 手順1〜2（generate / serve）まで通常どおり実行する。
2. レビュー対象の diff を読み、観点（バグ・セキュリティ・性能・可読性・規約）ごとにレビューする。指摘は1件ずつコメントとして投稿する:

   ```bash
   # 行に紐づく指摘
   agent-review-kit add-comment --file src/foo.ts --line 42 --body "指摘内容"
   # 行範囲
   agent-review-kit add-comment --file src/foo.ts --start-line 10 --end-line 20 --body "指摘内容"
   # レビュー全体への所感
   agent-review-kit add-comment --body "全体の所感"
   ```

   指摘は**現在の diff に含まれる行**に対して行う（diff 外の行は「現在の差分に位置づけできないコメント」として画面下部に落ちる）。`--side old` で削除側の行にも付けられる。
3. 投稿を終えたら、ユーザーに件数と URL を伝えて手順3〜4（案内・wait-comments）に進む。このとき「対応不要と判断した指摘は放置してよい（レビュー終了時に自動で見送りになる）」ことを一言添える。
4. **自分が投稿した指摘（AI コメント）はこの時点では処理しない。** wait-comments にも流れてこない（配達されるのはユーザー名義の open コメントだけ）。ユーザーが AI 指摘に**返信**したら、その返信が通常のコメントとして届くので、スレッド全体（親=自分の指摘）を読んで修正または回答する。修正の流れは手順7と同じ。
   - **修正完了時は2つ resolve する**: 届いた返信コメントを `--status fixed --message ... [--snapshot ...]` で resolve し、**親の AI 指摘も `--status fixed` で resolve する**（親が open のまま残ると未解決カウントに残り続ける）。
5. ユーザーが返信しなかった AI 指摘は、「レビュー終了」ボタンの押下時にサーバーが一括で `dismissed`（見送り）にする。エージェント側での後始末は不要。

## HTMLレビューモード

diff ではなく、実装プラン・設計書・調査結果などの任意HTMLをブラウザでレンダリング済みのまま見せてレビューさせたい場合の変形モード。ユーザーは要素クリック（要素選択モード）または文章のドラッグ選択でコメントする。ループの仕組み（serve / wait-comments / resolve）は通常と同一で、`generate` の代わりに `publish-html` でHTMLを登録・更新する。

1. レビュー対象のHTML（実装プラン等）を生成する。自己完結HTML（インラインCSS、外部リソース参照なし、スクリプト不要）にすること。HTMLは加工されずそのまま保存されるが、表示は iframe + CSP のためスクリプトは実行されず、外部CDN画像・外部CSS 等の外部リソースは読み込まれない（「セキュリティ」参照）。
2. 登録する:

   ```bash
   agent-review-kit publish-html --input <path> --document-id <id> --title "<タイトル>"
   ```

3. サーバーが未起動なら手順2と同じ確認方法で `agent-review-kit serve` をバックグラウンド起動する。
4. ユーザーに `http://localhost:<実ポート>/doc/<id>` を案内する。「要素を選択してコメント」ボタンで要素クリック、または文章をドラッグ選択してコメントできることを添える。
5. コメントを待つ:

   ```bash
   agent-review-kit wait-comments --document-id <id> --timeout 0
   ```

   常にバックグラウンドで常駐させ、完了通知（バックグラウンドタスクの終了）で受信を判定する（`ps`/`pgrep` での生存確認はしない）。二重起動もしない（「注意」の項目と同じ）。

6. 届いたコメントの `htmlTarget`（`label` / `selectedText` / `contextBefore` / `contextAfter`）でどこへの指摘か特定し、`documentId` に対応するHTMLの本体に対応する。
7. 必要に応じて元のプラン・設計・HTML・関連ファイルを修正する。
8. 更新したHTMLを同じ `--document-id` で `publish-html` し直す。開いているブラウザは自動リロードし、既存コメントは可能な範囲で元の位置に再配置される（再解決できないものは「位置を特定できないコメント」に残る）。
9. 対応を記録する:

   ```bash
   agent-review-kit resolve-comment <id> --status fixed --message "..."
   agent-review-kit resolve-comment <id> --status answered --message "..."
   agent-review-kit resolve-comment <id> --status wontfix --message "..."
   ```

10. 未解決コメントが無くなるか、`wait-comments` が `finished` を返すまで手順5〜9を繰り返す。

HTMLレビューでも、修正はサブエージェントに委譲し、メインセッションは受付・トリアージ・回答・resolve に徹する役割分担は通常のdiffレビューと同じ（「修正の委譲」参照）。`settings.readOnlyMode` 等の設定も同様に尊重する。

## 修正の委譲

メインセッションは受付・トリアージ・回答・取り込み・検証・resolve・generate に集中し、コード修正そのものは**コメント1件でもサブエージェントに委譲する**。

- サブエージェントのモデルは**セッションより軽いモデルを相対指定**する（特定のモデル名をスキルにハードコードしない）。設計判断をともなう大きな修正だけ、セッションと同等のモデルを使ってよい。
- 一度に複数コメントを受け取った場合は「対応で触るファイル・領域」でグルーピングする。同じファイルを触るコメント群は1つのサブエージェントにまとめて渡し、グループ間は並列実行する。
- **コメントが1件ずつ届く場合も同じ規則で振り分ける**: 修正コメントを受信したら、実行中のサブエージェントの担当ファイル/クレートと重なる場合のみそのエージェントに追送する。重ならない場合は直列キューに入れず、**必ず worktree エージェントを即時起動して並列化する**。「実行中のエージェントに追送する方が楽」を理由に独立な修正を直列化しない。
- **スナップショット都合で直列化しない**: 並列 worktree の修正は worktree 内でコミットさせ、`snapshot create --comment <id> --commit <sha>` でコメント単位のスナップショットを作れる（手順7参照）。並列でもコメントごとの修正差分リンクは成立する。
- **1 エージェントに複数コメントの修正を任せるときも、スナップショットはコメント単位を崩さない**: メイン working tree で連続修正させて最後に 1 つの合算スナップショットにすると、各コメントの「修正差分」リンクが全修正混在になり読めない（実際に指摘を受けた）。複数件を任せる場合は worktree で**修正ごとにコミット**させ、`snapshot create --comment <id> --commit <sha>` をコメントごとに作ってから resolve する。メイン tree 直接編集で進めてしまった場合は、修正間で main 側から snapshot begin/create を挟む。
- 並列実行するサブエージェントは **git worktree で隔離**する（Claude Code の Agent ツールなら `isolation: "worktree"`）。同一 working tree 上での並列編集はしない。サブエージェントが1体だけならメインの working tree を直接編集させてよいが、その実行中に新たな修正コメントが来て追加のサブエージェントを起動する場合、後発は worktree で隔離する。
- 各サブエージェントには、担当コメントの全文・対象ファイル・検証コマンド（型チェック/テスト）を明示し、検証まで通させ、変更内容（worktree の場合はそのパスまたはブランチ）を報告させる。
- 完了後、メインセッションが変更をメインの working tree に取り込む。**コンフリクトしたらその時点でメインセッションが解決する**（並列化を諦める理由にしない）。
- `resolve-comment --status fixed` は、変更をメインに取り込み、**メイン側で型チェック/テストが通ってから**実行する。worktree 内で通っただけでは fixed にしない。
- 全グループの取り込みが終わったら `generate` を再実行してレビューHTMLを更新する。

## 注意

- コメントごとに別プロセスの Claude Code を起動しない。このセッションがループの主体。受信・トリアージ・回答・resolve はメインセッションが行い、コード修正はサブエージェントが行う。
- 修正前に必ず現在の git diff を確認し、修正後に必ずテストまたは型チェックを実行する。
- `wait-comments --timeout 0` は**常にバックグラウンドで常駐させる**。サブエージェントの完了待ちの間もコメント受信を止めない。受信して返ってきたら（内容のトリアージ後に）すぐ再度バックグラウンドで起動し直し、レビュー中は監視が途切れないようにする。
- **wait-comments を二重に起動しない。** 再起動時は前のプロセスが終了していることを確認する。2本生きていると、新規コメントが stdout を誰も読まない側に消費され（`seen` 化だけされて）握り潰される。
- **waiter の起動コマンドには必ず監視対象ディレクトリへの明示的な `cd` を含める。** ark のコメントスコープは実行ディレクトリで決まるため、直前のコマンドの cwd（別リポジトリでの git 操作など）を暗黙に継承すると、無関係なスコープを監視する waiter ができてコメントを取りこぼす。起動後に `readlink /proc/<pid>/cwd` で監視先を確認するとより確実。
- **wait-comments の終了判定はバックグラウンドタスクの完了通知で行う。`ps`/`pgrep` でプロセスの生存確認をしない。** wait-comments は open コメントを1バッチ受信すると stdout に書いて即終了する設計で、この「終了」がバックグラウンドタスクの完了通知として届く。したがって「バックグラウンドで起動 → 完了通知が来たら受信済み＝終了済み → トリアージ → 再起動」というイベント駆動のサイクルで回せばよく、プロセス一覧での生存確認は不要。むしろ LLM の推論ループでプロセス状態をポーリングするのは高コスト（毎回コンテキスト再読込＋推論）で誤りやすく、避ける。どうしても確認する場合は `pgrep -af "[w]ait-comments"` のように**先頭文字をブラケットで囲って自己マッチを除外する**こと。`pgrep -f wait-comments` は検索コマンド自身のシェルプロセス（コマンドライン文字列に "wait-comments" を含む）にヒットし、実際には動いていないのに「動いている」と誤検出する。
- ユーザーのブラウザには、`seen` のまま応答が滞留したコメントを open に戻す「エージェントに再送」ボタンがある。再送されたコメントは**同じ id** で再度 wait-comments に届くので、既に対応済み・対応中の id なら重複として扱い、現在の状況（対応中/検証中など）を `--message` で返す。
- 受信したら即トリアージする: 質問はサブエージェントの完了を待たずメインセッションがその場で回答（`answered`）し、実装が必要なものは「修正の委譲」の方針に従って委譲またはキューイングする。
- レビュー対象の diff を変えたい場合（例: コミット後に base を変える）は `generate --base <ref>` を再実行する。
- ユーザーはコメントを論理削除できる（削除済みは wait-comments に配達されず、未解決数にも入らない）。対応中だったコメントが消えていたら、対応を中止してよい。
- `unresolved`（open + seen）にはユーザーが未対応の **AI 指摘も含まれる**。AI レビューモードでは「unresolved が 0 になるまで」を終了条件にせず、`finished` シグナルまたはユーザーの完了宣言で終了する。
- サイドバー下部にレビュー対象（base..HEAD）のコミット一覧があり、ユーザーはコミット単体の差分ページを開ける。エージェント側の操作は不要。
- **agent-review-kit 本体を更新した後は `generate` を再実行する**（`.agent-review/` の app.js / style.css は generate 時にコピーされるため、古いままだと新 UI・新 API が動かない）。

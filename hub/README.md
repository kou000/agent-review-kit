# review-hub — 統合レビューシェル

計画 / 差分レビュー / E2E計画 / E2E結果 を **1 つのブラウザページ（ヘッダタブ切替）** に統合表示する
ローカルツール。agent-review-kit（ark、`$AGENT_REVIEW_KIT_DIR`）のページを**無改修のまま iframe で埋め込み**、
タブごとの承認ボタン（計画承認・E2E 実行承認・PR 作成承認）を提供する。

- 依存ゼロ（Node 標準ライブラリのみ・ビルドなし）。Node 18+
- 127.0.0.1 バインドのローカル専用（認証なし・外部公開しない）
- 状態はすべて `~/.review-hub/` のファイル。対象リポジトリには何も書かない
- エージェント向けの操作手順は `skills/my-review-hub/SKILL.md`

## 仕組み

```text
ブラウザ  http://localhost:5280/s/<セッションID>
┌──────────────────────────────────────────────┐
│ [計画 ✓] [差分(backend) 2] [E2E計画] [E2E結果] │ ← タブバー + 承認ボタン
├──────────────────────────────────────────────┤
│ ✓計画 › 実装 › … | 作業メモ | 集計 | [⏸中断]  │ ← ステータスバー（フェーズ進行・中断ボタン）
├──────────────────────────────────────────────┤
│ iframe                                        │
│   ark-doc  → http://localhost:<arkPort>/doc/<id>   (publish-html したドキュメント)
│   ark-diff → http://localhost:<arkPort>/           (generate した diff レビュー)
│   static   → hub 自身が配信（E2E フルレポート。動画は Range 対応でシーク可）
└──────────────────────────────────────────────┘
```

- ark の URL は各プロジェクトの `.agent-review/server.json` から**リクエスト毎に解決**する。
  ark を再起動してポートが変わっても、ブラウザ側のポーリング（2.5 秒）で自動追従する
- タブの件数バッジは hub サーバが ark の `/api/comments` を取得して数える
  （ark は CORS ヘッダを返さないため、ブラウザから直接は取れない）。数え方は ark サイドバーの
  「コメント (要確認 N / 未解決 M)」と同じ**スレッド単位**で、タブ（doc / diff）ごとに絞る:
  - **要確認**（赤塗り。ark の tree-count と同色）: 回答・修正済み / wontfix / dismissed の確認待ち、または AI 指摘への返信待ち。ユーザーの番
  - **未解決**（薄い青地）: ユーザー名義の open/seen コメント、または working（名義を問わない）を含むスレッド。エージェントの番
  バッジは数字のみ（ホバーの title で意味を表示）
  `status --session` では `tabs[].check` / `tabs[].unresolved` と `checkTotal` / `unresolvedTotal`
- iframe はタブ切替でアンマウントしない（非表示でも ark のポーリング・コメント下書きが生きる）
- 表示中のタブはブラウザの localStorage に覚え、リロード後も同じタブに戻る（iframe 内のスクロール位置は戻らない）
- タブはドラッグで並べ替え（ブラウザの localStorage のみ）、右クリック →「このタブを非表示」で隠せる
  （ヘッダの「非表示 N ▾」から再表示）。非表示は session.json の `hidden` に記録され、`status` の
  `tabs[].hidden` / `waiterScopes[].allHidden` に出る。エージェントは全タブが非表示のスコープの
  wait-comments を止めてよい（Stop フック check-review-waiters.sh もそのスコープは咎めない）

## エージェント対応中の監視と催促

エージェントがコメントを受け取ったまま結果をスレッドに返さず止まる事故を、状態で検出する（`lib/agentWatch.js`）。
hub サーバは 30 秒ごとに、中断されていない各セッションの ark スコープ（タブの projectDir と docspace）の
コメントを ark の `/api/comments` で読み、スレッドごとに**最新のコメント（返信を含む）**の状態と、
その `updatedAt` からの経過時間を見る:

| 最新のコメント | しきい値 | hub の動作 |
|---|---|---|
| `seen`（配達済み・エージェントが持っている） | 3 分 | スレッドに【催促】を返信する（結果か、止まっている理由・ユーザーへの依頼を返すよう求める） |
| `working`（エージェントが「作業中・終わったら返信する」と宣言） | 5 分 | 【催促】を返信する（本当に作業中なら現状＝何をしていて、いつ頃終わる見込みかを書くよう求める） |
| `open`（未配達） | 3 分 | 催促しても配達されない（待ち受けが止まっている）ので投稿せず、ステータスバーに警告を出す |

- 催促はユーザー名義の **open の返信**として ark の `POST /api/comments` で投稿する（承認コメントと同じ経路）。
  wait-comments に配達され、止まっているエージェントのターンが始まる。本文は `【催促】（review-hub の自動投稿）…` で始まる
- 重複防止: 最新のコメントが未対応（open/seen）の催促なら再催促しない。エージェントが催促や大元を
  `working` にする・返信するなどして状態を更新すると、その時刻から数え直す
- 承認ボタンのコメント（【承認】）・作業の単位の開始ボタンのコメント（【開始】）も同じ規則。エージェント名義の open/seen（AI 指摘）は対象外。削除済み・手動修正の通知も対象外
- 催促の投稿は `events.jsonl` に `nudged`（失敗は `nudge-failed`）として残る
- ステータスバーには対応中（seen・working）の件数と最長の経過時間、3 分を超えた未配達の件数を出す。
  `status --session` の `agentWatch` にも同じ集計が出る（中断中は `null`）

## セッションモデル

1 セッション = 1 チケット（フロー 1 回）。複数リポジトリ（backend / frontend / E2E）を跨ぐため、
状態は対象リポジトリではなく `~/.review-hub/sessions/<id>/` に置く。

- `session.json` — タブ定義・承認状態・フェーズ/ステータス・返事待ち一覧・作業の単位・実行中のスキル・中断状態
- `events.jsonl` — 操作イベントログ（作成・タブ・承認・ステータス・中断/再開）。`status --session` の直近イベント欄の元
- `docspace/` — ドキュメント類（計画・E2E計画等）の publish 先として使う **非 git ディレクトリ**。
  ここで ark serve を起動すると ark のデータが固定スコープ（`no-git`）になり、
  作業リポジトリのブランチ切替の影響を受けない

## CLI

```bash
RH="node $REVIEW_HUB_DIR/bin/review-hub.js"

$RH serve [--port N]              # サーバ起動（フォアグラウンド常駐。既定ポート 5280〜自動スキャン）
                                  # Claude Code からは setsid nohup で切り離す（run_in_background は 2 時間で強制停止されるため）:
                                  #   mkdir -p ~/.review-hub/logs
                                  #   setsid nohup $RH serve > ~/.review-hub/logs/hub.log 2>&1 < /dev/null &
$RH start --session TICKET-123 --title "..." \
    --phases "計画,実装,差分レビュー,E2E,PR"     # セッション作成（既存なら再利用。--phases 省略時は左記が既定）
$RH set-status --session TICKET-123 --phase 実装 --note "コメント3件対応中"  # ステータスバー更新
$RH set-waiting --session TICKET-123 \
    --item "push してよいか" --item "plan::案 A と案 B のどちらで進めるか"  # 返事待ち一覧を丸ごと置き換え（ステータスバーの「返事待ち N件」。行を押すとその文をコピー）
                                  # --item は繰り返し可。「<タブid>::<文>」で関係するタブを付けると、一覧の行の右のタブ名チップを押してそのタブに切り替わる
                                  # 中身はエージェントが書いたものだけ（承認待ち・コメント件数は混ぜない）。status の waiting にも出る
$RH set-waiting --session TICKET-123 --clear       # 返事待ち一覧を空にする
$RH set-skill --session TICKET-123 --skill my-feature-ct \
    --skill-path ~/.claude/skills/my-feature-ct/SKILL.md   # 実行中のスキル（【開始】ボタンの指示文と status に使う）。--clear で外す
$RH set-units --session TICKET-123 \
    --unit "MR1:IAM ロールの作成" --unit "MR2:バッチの切り替え"  # 作業の単位を丸ごと置き換え（ステータスバーの「作業 n/m ▾」の一覧に開始ボタン）
                                  # --unit は繰り返し可。key は英数と ._-。同じ key の state・mr・着手時刻は引き継ぐ。--clear で空にする
$RH set-unit --session TICKET-123 --key MR1 --state mr-created --mr '!441'  # 状態: pending|started|mr-created|done
$RH interrupt --session TICKET-123 [--note "..."] [--all]  # 中断を記録し、このセッションの ark serve・wait-comments を停止（note は自分用メモ）
                                  # 稼働中の他セッションが使う ark は残す。hub は稼働中の他セッションが無いときだけ止める
                                  # --all: 全セッションに中断を記録し、全 ark・同じホストの全 hub を停止（サインアウト前用）
$RH resume --session TICKET-123                    # 中断解除（再開時）
$RH add-tab --session TICKET-123 --id plan --title 計画 \
    --type ark-doc --project-dir <docspace> --doc-id plan \
    --approval-label "計画を承認して修正開始"
$RH add-tab --session TICKET-123 --id diff-backend --title "差分 (backend)" \
    --type ark-diff --project-dir ~/my-app
$RH add-tab --session TICKET-123 --id e2e-report --title E2E結果 \
    --type static --path ~/e2e-reports/TICKET-123 --approval-label "PR 作成を承認"
$RH approve-status --session TICKET-123      # 承認状態の確認（承認の受け取り自体は ark の wait-comments。下記「承認の届き方」）
$RH wait-approval --session TICKET-123 --tab plan --timeout 6600   # 旧方式の承認待ち（互換用。スキルでは使わない）
$RH remove-tab --session TICKET-123 --id reproduce
$RH hide-tab --session TICKET-123 --id plan     # 非表示（ブラウザの右クリックと同じ）/ show-tab で解除
$RH url [--session TICKET-123]
$RH status --session TICKET-123     # 現況サマリ（フェーズ・承認・未解決数・直近イベント）。--session なしは一覧
$RH stop
```

すべて JSON を stdout に返す。`add-tab` は同じ `--id` で再実行すると定義更新（承認状態は保持）。

### 作業の単位の開始ボタン

計画を複数の MR に分けたとき、`set-units` で単位（MR1・MR2…）を登録する。ステータスバーには「作業 n/m ▾」
（m は単位の数、n は mr-created・done の数。未着手があると緑の枠線で目立たせる。単位が無ければ出さない）だけを置き、
押すと返事待ちの一覧と同じ形で単位ごとの key・label・状態・mr の一覧が開く。未着手（pending）の行には
「開始」ボタンが出て、押すと確認のうえ hub が docspace の ark の全体コメントとして次の本文を投稿し（intent: fix）、
state を `started` にする。投稿できなければ state を変えずにエラーを返す（開始ボタンが残るので押し直せる）。
着手済み以降の単位を押し直しても（別ウィンドウなど）コメントは重ねて投稿しない。

```
【開始】「<label>」（<key>）の作業を始めてください

作業を始める前に、実行中のスキル <skill.name> の SKILL.md（<skill.path>）を Read で全体を読み直し、これから進める Step の手順をこのスレッドに書き出してから、Step 5（ブランチ作成）から順に進めること。差分タブを追加したら、AI レビューの前にすぐ hub の URL を案内すること。
```

`set-skill`（または `start --skill`）が無いときは 2 段落目がスキル名なしの「実行中のフローのスキルの SKILL.md を Read で…」になる。
エージェントは承認と同じく docspace の `wait-comments` で受け取る。

### 承認の届き方

ブラウザの承認ボタンは、push 依頼ボタンと同じく **ark のコメント**としてエージェントに届く
（本文は `【承認】「<ラベル>」が押されました（タブ: <タブ名>）`、intent: fix）。
承認バーの入力欄に追加指示（例: 承認後そのまま MR 作成まで進める）を書くと、空行を挟んで本文の後ろに付き、
`approve-status` の `note` にも残る。
エージェントは通常のコメントと同じ `wait-comments` で受け取り、resolve するまで未解決として残る。

| タブ種別 | 投稿先 |
| --- | --- |
| ark-doc | そのドキュメント宛のコメント |
| ark-diff | その ark の全体コメント |
| static | docspace の ark の全体コメント |

タブの ark に投稿できない（停止・レビュー終了済み）ときは docspace の全体コメントにフォールバックし、
どこにも投稿できなければ承認を記録せずエラーを返す（ボタンが残るので押し直せる）。
承認バーには承認コメントの配達状況（受信待ち / 受信済み）が出て、1 分以上未受信なら警告になる。

## HTTP API

| ルート | 内容 |
| --- | --- |
| `GET /` | 最新セッションへリダイレクト |
| `GET /s/<id>` | シェルページ |
| `GET /api/sessions` | セッション一覧 |
| `GET /api/session/<id>` | タブ定義 + 解決済み iframe URL + ark 死活/未解決数 |
| `POST /api/session/<id>/approve` | `{tabId, note?}` で承認。ark へ承認コメントを投稿してから記録する（投稿できなければ 502 で記録しない） |
| `POST /api/session/<id>/start-unit` | `{key}` で作業の単位を開始。docspace の ark へ【開始】コメントを投稿してから state を `started` にする（投稿できなければ 502 で記録しない。pending 以外は投稿せず `already` を返す） |
| `POST /api/session/<id>/tab-visibility` | `{tabId, hidden}` でタブの非表示を記録（タブの右クリックメニュー / 「非表示 N ▾」メニュー） |
| `POST /api/session/<id>/interrupt` | `{note?}` で中断記録 + このセッションの ark serve・その wait-comments を停止（ステータスバーの中断ボタン。wait-comments は `interrupted` を返す）。稼働中の他セッションが使う ark は残し、hub 自身は別の hub が動いているか稼働中の他セッションが無いときだけ終了する |
| `GET /static/<sessionId>/<tabId>/<path>` | static タブの配信（Range 対応） |

hub はフェーズを跨いで常駐する前提。例外は `/interrupt`（中断ボタン）で、そのセッションの ark serve を
止めたうえで、他セッションの表示が途切れない場合は hub 自身も終了する。
同じホストで hub を複数起動しても状態フォルダ（`~/.review-hub`）は共有されるため、中断は
「稼働中の他セッション」（中断されておらず、中断するセッションと共有していない ark が生きている）を
基準に止める範囲を決める。

## 注意

- ark ページ内の「レビュー終了」ボタンは **ark サーバを停止させる**。承認はタブ上部の
  承認ボタンで行い、「レビュー終了」は押さない（復旧手順は my-review-hub スキルの手順 8）
- ark の doc（publish-html）は CSP により外部ファイル参照不可。E2E の動画・スクショを
  そのまま見せたい場合は static タブ（hub 配信）を使う

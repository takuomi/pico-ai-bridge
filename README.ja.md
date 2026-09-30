# Pico AI Bridge（非公式）

[English](https://github.com/takuomi/pico-ai-bridge/blob/main/README.md) | 日本語

**非公式プロジェクトです。** このブリッジは、Pico AI Server（旧 Pico AI Homelab）の開発元である Starling Protocol と提携しておらず、同社の承認も受けていません。

Pico AI Bridge は、Claude から Pico AI Server 上のモデルを呼び出せるようにするローカルの stdio MCP サーバーです。読みやすい JavaScript と Node.js の標準機能だけで動作し、実行時の追加パッケージもビルド工程も不要です。

## 必要なもの

- Apple Silicon 搭載 Mac 上で動作し、Claude を実行するマシンから接続できる Pico AI Server。Claude Desktop 拡張機能はインストール時に URL の入力が必要です。Claude Code プラグインの既定値は `http://localhost:11434` です。
- Claude Code プラグインまたは手動設定: `PATH` 上に Node.js 20 以降。
- Claude Desktop 用 `.mcpb`: Desktop に内蔵された Node.js を使用します。

## ツール

| ツール | 用途 |
| --- | --- |
| `pico_server_info` | 接続状態を確認し、バージョン、名前、ビルド、バンドル識別子を返します。 |
| `pico_list_models` | `/v1/models` と `/api/tags` を統合します。必要に応じて `/api/show` で機能を調べます。 |
| `pico_responses` | Responses API による生成と関数呼び出し。 |
| `pico_chat_completions` | Chat Completions による生成。 |
| `pico_ollama_chat` | Ollama Chat による生成とオプション。 |
| `pico_compare_models` | 利用者が明示的に選ぶ、2 個以上のモデルの順次比較。 |

通常モードでは、結果の抽出や計算に使用する Pico 応答フィールドが存在し、`null` でない場合、期待される JSON 型でなければなりません。不正な型はエンドポイントのメッセージとともに `unexpected_response` を返します。省略または `null` の任意項目は `null` のままです。この規則は比較結果の各行にも適用されます。raw モードでは、API キーを伏せた後の解析済み Pico 本文を返します。JSON に有限でない数または安全でない整数が含まれる場合は、元のテキストを伏せ字にして返します。ツール呼び出しの引数 JSON に安全でない整数がある場合は、テキストのまま返します。このような数値を含む 2xx 本文は通常モードで `response_parse_failed` を返し、Pico HTTP エラーでは元のテキストを本文にします。

すべてのツールで `raw: true` を指定できます。単一エンドポイントでは、HTTP ステータスと解析した Pico の本文（JSON でない場合はテキスト）を `structuredContent: {status, body}` で返します。テキスト内容には、JSON 化した本文、または本文が文字列ならその文字列が入ります。設定された API キーは Pico 本文の値とキーで伏せられます。Pico HTTP エラーは `{source: "pico", status, body}` と `isError: true` を返します。raw の `pico_list_models` は `v1_models` と `api_tags` のステータス・本文の組を返し、`include_capabilities` を指定すると `/api/show` に送った名前をキーとする `api_show` も返します。Pico HTTP エラーがあれば `isError: true` になります。raw の `pico_compare_models` は、成功したモデルの `status`、`body`、`elapsed_ms` を返します。比較で失敗した行には `error` が入り、比較は続行します。外側の結果には `isError` が付きません。

`pico_list_models` は Ollama のモデル名規則に従って `/v1/models` と `/api/tags` を統合します。タグのない名前は `:latest` として扱います。通常モードの各項目には、`/v1/models` の `data` から `id`、`created`、`owned_by`、同 API の `models` 配列から `display_name`、`status.value` から `status`、`/api/tags` から `name`、`tag_model`、`format`、`family`、`parameter_size`、`quantization_level`、`size_bytes`、`modified_at` が入ります。`size_gb` はバイト数を 1e9 で割って小数第 2 位に丸めた値です（値がない場合は `null`）。`include_capabilities` を指定すると、統合後の各モデルについて `/api/show` を一度呼び出し、`/api/tags` の名前、そこにない場合は `id` を送ります。成功時は `capabilities` と `context_length`、Pico HTTP エラー時は `capabilities_error: {source, status, body}` が加わります。一覧取得エンドポイントの HTTP エラーは `{path, error: {source, status, body}}` の形で `partial_errors` に入ります。両方が失敗した場合は `{models: [], partial_errors}` と `isError: true` を返します。接続失敗やタイムアウトはブリッジエラーです。成功した一覧の形が不正なら `unexpected_response` を返します。`/v1/models` には文字列の `id` を持つ `data` の各オブジェクト、存在する場合はオブジェクトの `status` が必要で、その `value` は `null` 以外なら文字列でなければなりません（`value` の省略または `null` は `status: null` として抽出します）。`models` がある場合はオブジェクトの配列でなければなりません。`/api/tags` には文字列の `name` を持つ `models` の各オブジェクトが必要です。`size` がある場合は有限の数値でなければなりません。通常モードでは `/api/show` の成功本文がオブジェクトでない場合、`capabilities` が文字列の配列でない場合、`model_info` がオブジェクトでない場合、または `.context_length` が有限の数値でない場合も `unexpected_response` になります。省略または `null` の任意項目は `null` のままです。機能を取得しない raw の一覧では形を検証しません。`include_capabilities` を指定した raw の一覧では、`/api/show` を呼ぶために、成功した `/v1/models` の `data` が文字列の `id` を持つオブジェクトの配列であり、成功した `/api/tags` の `models` が文字列の `name` を持つオブジェクトの配列であることだけを検証します。`status`、`size`、その他のフィールドは検証しません。

生成では、Chat Completions に `prompt`、`messages`、画像、または `system` のみが必要です。これらがいずれもない場合は `extra.messages` も入力として使用できます。Ollama はこれらの入力を受け取り、`messages` を省略することもできます。渡されたメッセージ項目はそのまま送ります。比較では `prompt` または `messages` の一方、または `images` のみを受け取ります。`api: "responses"` の場合、指定された `messages` 配列は Responses の `input` として送ります。比較の `system` は Responses の `instructions` になり、画像は以下の説明どおりに追加します。Chat と Ollama の生成では、`system` は先頭にシステムメッセージを追加します。`system` のみなら、そのメッセージだけを送ります。Responses は任意の文字列または項目配列の `input` を受け取り、その項目をそのまま送ります。任意の `instructions` も使えます。Responses に `messages` 引数はありません。`input` がない場合は省略し、Pico の結果をそのまま渡します。`images` は最後のユーザーメッセージに付けます。文字列の内容はテキストと画像のパーツになり、配列の内容には画像パーツを追加します。Ollama ではそのメッセージの `images` に base64 文字列を追加します。`data:`、`http://`、`https://` で始まる項目（ASCII の大文字小文字を区別せず、先頭に空白なし）は URI とし、それ以外はローカルファイルパスとします。`~` そのもの、および `~/` で始まるパスは、ブリッジプロセスのホームディレクトリを基準に解決します。それ以外のパスは指定どおりに使用し、相対パスはブリッジプロセスの作業ディレクトリを基準に解決します。分類後、Ollama のすべてのデータ URI を URL として解析し、ASCII のタブと改行を除去し、前後の C0 制御文字と空白を取り除きます。その後、最初のコンマを探す前にフラグメントを取り除きます。そのコンマ以降をパーセントデコードしてバイト列にします。前後の ASCII 空白を除いたメディアタイプが `;`、任意個の空白、`base64` の順で終わる場合（`base64` の大文字小文字は区別しません）、そのバイト列を forgiving-base64 で復号します。ASCII 空白と省略可能なパディングを受け付けます。結果のバイト列を標準的な base64 にして送ります。パーセント記号の後に ASCII の 16 進数字が 2 桁続かない場合、その記号はそのまま 1 バイトとして残します。不正な URL、コンマの欠落、不正な base64 は `invalid_arguments` を返します。画像 URL はそのまま渡します。画像以外の入力がない場合、空の `messages` または `input` 配列を指定した場合も含め、画像だけを含むユーザーメッセージを 1 件送ります。ツールの数値引数には有限数と安全な整数が必要です。`extra`、`messages`、`tools`、`options` の中を含め、引数のどこかに有限でない数、または絶対値が `Number.MAX_SAFE_INTEGER` を超える整数があると、JSON で値が失われるため拒否します。無効な値はリクエスト前に `invalid_arguments` を返します。対象の内容がほかの形なら、画像の読み取り前に `invalid_arguments` を返します。Ollama で画像を追加する場合、対象ユーザーメッセージに既存の `images` フィールドがあり、配列でなければ、画像の読み取り前に `invalid_arguments` を返します。ローカルパスは画像形式を確認せずに読み取り、画像 URL は取得しません。Chat の `response_format`、Responses の `json_schema` と必須の `json_schema_name`（`text.format: {type: "json_schema", name: json_schema_name, schema: json_schema}` として送信）、Ollama の `format` は Pico に送ります。ブリッジは回答をスキーマで検証しません。Responses の `previous_response_id` は指定値をそのまま送ります。`tools` は各 API の形式で送ります。すべての POST ツールは `stream: false` を送り、`extra.stream` は競合します。ツールが送るほかのフィールドと `extra` のキーが重なる場合も、画像の読み取りや HTTP リクエスト前に `invalid_arguments` を返します。生成の `model` 引数は任意で、省略時の選択は Pico に任せます。GET ツールは `extra` と `split_thinking` を受け取りません。

通常モードの Chat Completions は最初の選択肢から `answer`、`refusal`（`message.refusal`、ない場合は `null`）、`reasoning`、`response_model`、`finish_reason`、`response_id`、`created`、`usage`、`{id, type, name, arguments}`（function 項目）または `{id, type, name, input}`（custom 項目）の `tool_calls` を返します。custom の `input` は自由形式のテキストとして保持します。Responses は全 `output_text` パーツを出力順に連結し、`answer`、出力順に連結した `refusal` パーツの文字列（ない場合は `null`）、`reasoning`、`response_model`、`status`、`response_id`、`created_at`、`completed_at`、`cached_tokens` を含む `usage`、`error`、`incomplete_details`、`{id, call_id, name, arguments, status}` の `function_calls` と `{id, call_id, name, input, status}` の `custom_tool_calls` を返します。両方の配列は常に存在し、custom 呼び出しの `id` と `status` がない場合は `null` になります。Ollama は `message.content` を `answer` として返し、`reasoning`、`response_model`、`finish_reason`、件数の `usage`、`durations_ms`、`created_at`、`done`、`{id, name, arguments}` の `tool_calls` も返します。これらのフィールドで値がない場合は `null` を使用します。通常モードの比較成功行には `model`、`answer`、`reasoning`、`response_model`、API に応じた `tool_calls`、または Responses の `function_calls` と `custom_tool_calls`、`finish_reason` または `status`、Chat では `response_id` と `created`、Responses では `response_id`、`created_at`、`completed_at`、Ollama では `durations_ms`、`created_at`、`done`、Chat と Responses の `refusal`、Pico が返した場合の `usage`（Ollama は常に `{prompt_eval_count, eval_count}` を返し、件数がない場合は `null`）、`elapsed_ms` が入ります。Responses の比較行には `error` と `incomplete_details` も入り、Pico の本文にない場合はそれぞれ `null` になります。比較に失敗した場合は、その行に `error` を記録します。送信済みリクエストがタイムアウトした場合、同時実行数の上限が 1 を超えていても、Pico での処理が終了するまで次のモデルを送信しません。MCP のキャンセル時にはこの待機を終了し、比較を停止します。通常モードの生成と比較は 2xx 本文の形を確認します。Chat には空でない `choices` 配列が必要で、その先頭項目のメッセージの `role` は文字列でなければなりません。`content` は空文字列を含む文字列、`null`、または省略が可能で、`null` または省略の場合は回答が空文字列になります。Chat の `refusal` は文字列、`null`、または省略が可能です。`reasoning_content` と `reasoning` はそれぞれ文字列、`null`、または省略が可能です。Chat の `tool_calls` は配列、`null`、または省略が可能です。配列内の各項目には文字列の `id` と `type` が必要です。`type: "custom"` の場合はオブジェクトの `custom` と、文字列の `custom.name` および自由形式のテキストである `custom.input` が必要です。それ以外の型には、オブジェクトの `function` と文字列の `function.name`、`function.arguments` を求める規則を適用します。Ollama には文字列の `role` を持つメッセージが必要で、`content` は空文字列を含む文字列でなければなりません。`thinking` は文字列、`null`、または省略が可能です。Ollama の時間フィールド（`total_duration`、`load_duration`、`prompt_eval_duration`、`eval_duration`）がある場合は有限の数値でなければなりません。`null` と省略は出力でも `null` になります。Ollama の `tool_calls` は配列、`null`、または省略が可能です。配列内の各項目はオブジェクトで、オブジェクトの `function` と文字列の `function.name` が必要で、`function.arguments` は省略、`null`、オブジェクト、または文字列が可能です。省略または `null` は `arguments: null` として抽出します。Responses には文字列の `type` を持つオブジェクトの `output` 配列が必要です。各項目の `content` と `summary` は配列、`null`、または省略が可能です。配列内の各パーツは文字列の `type` を持つオブジェクトでなければなりません。`text` は文字列、`null`、または省略が可能ですが、`output_text`、`summary_text`、`reasoning_text` パーツでは文字列の `text`、`refusal` パーツでは文字列の `refusal` が必要です。`function_call` 項目では `name`、`call_id`、`arguments` が文字列でなければなりません。`custom_tool_call` 項目では `name`、`call_id`、自由形式のテキストである `input` が文字列である必要があり、任意の `id` と `status` も存在する場合は文字列でなければなりません。使用しないフィールド、Chat の 2 番目以降の選択肢、項目同士の意味的な関係、引数の文字列やオブジェクトの内容は検証しません。空の回答も有効です。

POST ツールの `split_thinking` は既定で `true` です。対応する開始タグのない閉じタグ `</think>` より前を推論に分け、続いて `<think>...</think>` の組を回答から除いて推論に連結します。`split_thinking: false` では回答内のテキストを残しますが、Pico が別フィールドで返す推論は使用します。Responses の推論項目は空でない `summary`、それ以外は `content` を使用します。`reasoning_effort` は Chat では `reasoning_effort`、Responses では `reasoning.effort` として渡します。Ollama の `think` は真偽値を受け取ります。段階を表す文字列や `null` は `extra.think` として指定すると、そのまま送ります。テストしたサーバーは `null` を受け付け、段階を表す文字列を拒否しました。テストでは、`think` が文字列も受け付ける定義だった場合、Claude Desktop のチャット（Sonnet 5.5 と Opus 5.5）は `true` を文字列の `"true"` として送り、Claude Code は真偽値として送りました。比較ツールの `reasoning` は Chat（`reasoning_effort`）と Responses（`reasoning.effort`）に適用され、`think` と `options` は Ollama にのみ適用されます。API に適用できない引数を使うと `invalid_arguments` になります。Ollama の比較では `options.num_predict` と `max_tokens`、`options.temperature` と `temperature` がそれぞれ競合し、同じエラーになります。

テストした Pico サーバーでは、Ollama のツール呼び出しを再送する際、`tool_calls` の各項目に `id`、`type: "function"`、文字列の `function.arguments` を持つ assistant メッセージと、対応する `tool_call_id` を持つ tool メッセージが必要でした。そのサーバー自身が返した ID のない呼び出しをそのまま再送すると拒否されました。Chat Completions では、ブリッジは有効な JSON の `tool_calls[].arguments` を JSON の値に解析します。再送時は assistant メッセージの `function.arguments` を JSON 文字列に戻し、対応する tool メッセージを加えます。例: `messages: [{role: "assistant", tool_calls: [{id: "call_1", type: "function", function: {name: "get_weather", arguments: "{\"city\":\"Tokyo\"}"}}]}, {role: "tool", tool_call_id: "call_1", content: "{\"temperature_c\":20}"}]`。Responses では user 項目、`function_call` 項目、`function_call_output` 項目を再送すると成功し、`previous_response_id` と `function_call_output` 項目だけを送ると拒否されました。テストしたサーバーは Chat の custom ツールに HTTP 400 と ``Coding key `function` not found.`` を返しました。Responses は custom ツール定義を受け取りましたが、custom 呼び出しではなくメッセージを返しました。また、テストしたサーバーは、JSON スキーマのオブジェクトを指定した Ollama の `format` と、`description` のない Chat の function ツール定義に HTTP 400 を返しました。Ollama と OpenAI の API リファレンスでは、どちらも有効な形式とされています。テストしたサーバーでは、Ollama の `think: true` に対し、テストしたどのモデルも `thinking` のテキストも回答内の `<think>` テキストも返しませんでした。一方、`LFM2.5-1.2B-Thinking-4bit` は `think: false` のとき回答内に `<think>` テキストを書き、`split_thinking` がそれを `reasoning` に移しました。他のサーバーでは動作が異なる場合があります。

ブリッジエラーは `{source: "bridge", kind, message}` です。Pico HTTP エラーではステータスと解析した本文を保持します。Pico 由来の値を抽出した後、設定された API キーを値と、Pico オブジェクトをそのまま返す場合のキーで伏せます。対象には raw とエラーの本文、使用量、Responses の `error` と `incomplete_details`、ツール呼び出し引数、モデルの各項目、`api_show` のキーが含まれます。ブリッジが作るフィールド名は固定です。リダイレクトは追跡しません。`pico_server_info` は `bundle_identifier` を含み、名前、バージョン、ビルド、バンドル識別子がない場合に `null` を返し、バージョンから API 対応を推定しません。成功した `/api/version` の本文がオブジェクトでない場合は `unexpected_response` を返します。

## インストール

### Claude Code マーケットプレイス

```text
/plugin marketplace add takuomi/pico-ai-bridge
/plugin install pico-ai-bridge@pico-ai-bridge
```

### プラグイン zip

[Releases](https://github.com/takuomi/pico-ai-bridge/releases) から `pico-ai-bridge-<version>-plugin.zip` をダウンロードし、**Customize > Plugins > Upload plugin** で開きます。Claude Code v2.1.273 以降に同じ Claude アカウントでサインインしている場合、Claude Code の起動時に毎回プラグインが同期されます。API キーまたは Amazon Bedrock などのクラウドプロバイダーで Claude Code を使用する場合は同期されません。アップロードしても、そのローカルサーバーを claude.ai の Web チャットで使用できるようにはなりません。

### Claude Desktop 拡張機能

Releases から `pico-ai-bridge-<version>.mcpb` をダウンロードしてダブルクリックするか、**Settings > Extensions > Advanced settings > Install Extension** を使用します。

### 手動 MCP 設定

Claude Code の場合:

```sh
claude mcp add pico-ai-bridge --env PICO_BASE_URL=http://localhost:11434 -- node /absolute/path/to/pico-ai-bridge/server/index.js
```

Claude Desktop では、`claude_desktop_config.json` に追加します:

```json
{
  "mcpServers": {
    "pico-ai-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/pico-ai-bridge/server/index.js"],
      "env": { "PICO_BASE_URL": "http://localhost:11434" }
    }
  }
}
```

## 対応環境

| 環境 | 対応状況 |
| --- | --- |
| Claude Desktop チャット | `.mcpb` と内蔵 Node.js で使用できます。 |
| Claude Code CLI とデスクトップの Code タブ | プラグインまたは手動設定で使用できます。Node.js 20 以降が必要です。 |
| Cowork | 現時点では未対応です。 |
| claude.ai の Web・モバイルチャット | ローカル MCP サーバーが読み込まれないため未対応です。 |

## 設定

| プラグイン設定 / 環境変数 | 既定値 | 意味 |
| --- | --- | --- |
| `base_url` / `PICO_BASE_URL` | Claude Desktop 拡張機能: インストール時に入力必須（既定値なし）。Claude Code プラグイン: `http://localhost:11434`。 | Pico サーバーの URL。URL に認証情報を含めず、API キーを使用してください。 |
| `api_key` / `PICO_API_KEY` | 空 | 認証用の任意の Bearer トークン。 |
| `timeout_ms` / `PICO_TIMEOUT_MS` | `300000` | リクエストと本文の読み取りに対する呼び出し元のタイムアウト。整数の有効範囲は 1～2147483647 ms。 |
| `max_concurrent_requests` / `PICO_MAX_CONCURRENT_REQUESTS` | `1` | Pico への HTTP リクエスト数の FIFO 制限。複数の大きなモデルを同時に読み込むと Mac のメモリが不足する可能性があります。 |

待機中のリクエストがタイムアウトした場合は、Pico に送信せずに待機列から除去します。個別のリクエストはタイムアウトエラーを速やかに返します。送信後にタイムアウトしたリクエストは、Pico が終了して本文の読み取りが終わるまで FIFO の許可枠を保持します。比較では、そのリクエストの終了を待ってから次のモデルを開始するため、個別のタイムアウトより後に結果が返る場合があります。MCP のキャンセル時には比較の待機を速やかに終了します。キャンセルで除去するのは待機中のリクエストだけです。送信済みのリクエストは中断しません。テストでは、Pico の生成中に接続を閉じた後、次の生成リクエストでサーバーが停止しました。

[プライバシーポリシー](https://github.com/takuomi/pico-ai-bridge/blob/main/PRIVACY.md) を参照してください。

`PICO_BASE_URL` が未設定、空、または未置換のプレースホルダーの場合、すべてのツール呼び出しで `invalid_configuration` として拒否されます。拡張機能またはプラグインで `base_url` を設定するか、手動利用では `PICO_BASE_URL` を設定してください。

不正な形式の `base_url`、HTTP または HTTPS 以外のプロトコルを使う URL、認証情報、クエリ、フラグメントを含む URL は、すべてのツール呼び出しで `invalid_configuration` として拒否されます。整数の有効範囲外のタイムアウト、または 1 以上の安全な整数でない同時リクエスト数を指定した場合も `invalid_configuration` が返ります。空または未置換の値には既定値を使用します。

## 開発

`npm test` はソートした `test/*.test.js` を、`npm run test:conformance` はソートした `dev/*.test.js` を実行します。対象ファイルがない場合はエラーになります。`test/tools-contract.json` には 6 つの公開ツール定義が記録され、単体テストとアダプター適合性テストで照合されます。`npm run test:live` は `PICO_BASE_URL` に対して `test/live.js` を実行します。CI の `scripts/smoke-artifacts.py` は各アーカイブを展開し、マニフェストに宣言されたコマンド、引数、環境変数の値を置換して、Linux、macOS、Windows 上でローカルの模擬 Pico に対して `initialize` と `pico_server_info` を実行します。Claude Desktop または Claude Code へのアーカイブのインストールは行いません。

```sh
npm test
npm ci --prefix dev
npm run test:conformance
npm run check:size
PICO_BASE_URL=http://localhost:11434 npm run test:live
```

ライブテストでは `PICO_TEST_TOOLS_MODEL` と `PICO_TEST_VISION_MODEL`（どちらも既定値は `Qwen3-VL-2B-Instruct-4bit`）、および `PICO_TEST_THINKING_MODELS`（カンマ区切りのリスト、既定値は `LFM2.5-1.2B-Thinking-4bit`）を使用します。`deepseek-r1-distill-qwen-1.5b-4bit` は、テストしたサーバーで `/api/chat` の応答に約 2 分かかることがあり、`message` を含まずに終了したため、既定値には含めていません。他のサーバーでは異なる動作になる場合があります。各役割に割り当てるモデルには、少なくとも 2 種類の異なるモデルが必要です。重複を除いた全モデルで、温度 0、上限 4096 トークンを指定して、3 つの API の通常モードと raw モードによる生成を実行します。また、出荷用の `server/index.js` stdio サーバーを起動し、legacy の `initialize` と整数 ID を使って 6 つの各ツールを呼び出します。3 つの生成 API は通常モードと raw モードの両方で呼び出し、各結果と、標準入力を閉じた後に終了コード 0 で終了することを確認します。また、`initialize` を使わずに 2026-07-28 のリクエストごとのメタデータでサーバーを検出し、6 つのツールを列挙して、出荷用 stdio サーバー経由で 3 つの生成ツールをそれぞれ呼び出します。比較は温度 0、上限 3072 トークンで順次実行し、3 つの API の通常モードと raw モードを検証します。追加の 3 つの API の通常モード比較では `messages: [{role: "user", content: prompt}]`、温度 0、上限 1024 トークンを使用し、すべての行にエラーがなく、回答があることを確認します。Chat の通常モード比較では、生成した赤色の PNG を画像用モデルとツール用モデルに追加します。両者が同じ場合は画像用モデルを 2 回指定し、同じ設定と行の確認を行います。小規模な推論モデルがときどき生成を続けすぎるため、温度 0 を使用します。また、GET ツール、モデルの統合と機能、ツール呼び出しと結果の往復、JSON 形式、システム指示、`extra`、`keep_alive`、`previous_response_id`、画像内容の形も検証します。構造化出力形式、`keep_alive`、`previous_response_id` のライブテストは、Pico がリクエストを受け付けたかを確認します。送信される正確なフィールドはユニットテストで検証します。ツール呼び出し、画像、推論の動作は、機能メタデータによる実行条件や再試行を設けず、各役割のモデルで直接検証します。画像テストでは一時的に生成した赤色の PNG を使用します。指示文のある呼び出しでは赤色を示す回答を期待し、画像のみの呼び出しでは空でない回答を確認します。Responses の `reasoning_effort` は、成功する必要がある `low` と、Pico HTTP 400 を返す必要がある無効な値で検証し、値が `reasoning.effort` として Pico に届くことを確認します。各推論モデルでは Ollama の `think:true` と `think:false` をテストします。`think:false` のサブテストでは実際の出力に対するブリッジの不変条件を確認します。分離を有効にしたときは完全な `<think>...</think>` の組が回答に残らず、`split_thinking: false` のときは回答を分離せず推論を空にします。モデルがインラインの推論を書くことは必須条件にしません。存在しないモデルについては、3 つの API のすべてで Pico HTTP 404 を確認し、raw モードと通常モードのエラーデータが同一で、本文が Pico への直接リクエストの応答と一致することを確認します。`PICO_TEST_BROKEN_MODEL` では、Pico エラーを返すと想定する別のモデルを任意で指定できます。3 つの API で raw と通常モードを直接の Pico HTTP 応答と照合します。さらに通常モードの Chat 比較でエラーがその行に記録され、ツール用モデルの行が成功することを確認します。別の比較ではタイムアウトを 1000 ms、同時実行数を 2 に設定します。ローカルの転送プロキシで Chat リクエストの到着時刻と応答の完了時刻を記録し、タイムアウトした応答が完了した後に次のモデルのリクエストが到着することを確認します。その後、サーバー情報と短い Chat を確認します。

SDK v2 の依存パッケージと適合性テストは `dev/` のみにあります。正式な v2 クライアントを使った同じ検証を、出荷用アダプターと SDK アダプターに対して、legacy、modern 固定、auto-detect の各モードで実行します。modern クライアントは 2026-07-28 のリクエストごとのメタデータを使用し、`server/discover` と modern の `-32022` エラーは、後続リクエスト用に `2026-07-28` のみを列挙します。legacy クライアントは `initialize` で 4 つの legacy 版のいずれかを交渉します。各リクエストは自身の `_meta` に基づいて modern の処理を選びます。`params._meta` が存在してオブジェクトでないリクエストは、どちらのプロトコルでも `-32602` を受け取ります。modern メタデータがない legacy リクエストには同じ接続で成功した legacy の `initialize` が必要ですが、`ping` は例外です。modern リクエストの後も legacy の `initialize` を受け付けます。リクエスト ID は文字列か安全な整数でなければならず、無効な ID には null ID と `-32600` を返します。modern MCP では `ping` が削除されたため、適合性テストでは legacy モードでのみ検証します。stdio で 2025-03-26 または 2024-11-05 の `initialize` に成功した後、空でない JSON-RPC バッチでは、通知とキャンセルされたリクエストを除き、応答が必要な要素があれば 1 つの配列で返します。通知だけ、またはキャンセルされたリクエストだけのバッチには何も書き込まず、空のバッチには単独の `-32600` エラーオブジェクトを返し、バッチ内の `initialize` にはその要素の `-32600` を返し、modern のリクエスト要素にはそれぞれ `-32600` を返します（modern の通知には応答しません）。`initialize` 前、新しい legacy 版、およびリクエストごとの modern 処理では、配列の行は無効です。[設計](https://github.com/takuomi/pico-ai-bridge/blob/main/ARCHITECTURE.md) を参照してください。

Pico AI Server とその名称は、それぞれの所有者の商標です。このプロジェクトは独立した MIT ライセンスのプロジェクトです。

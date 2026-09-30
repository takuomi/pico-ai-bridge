# Privacy Policy

Effective date: 2026-09-27.

The author collects no data and operates no service or telemetry endpoint for this plugin. The bridge sends prompts, messages, and image content only to the configured Pico AI Server URL. For each local path in `images`, it reads the file and sends its bytes to Pico without checking that it is an image. Image URLs supplied by the caller pass unchanged to Pico; the bridge does not fetch them.

The bridge does not follow redirects.

The bridge stores no prompts, responses, or image data. Claude stores plugin configuration; the optional API key is declared sensitive. The bridge sends no telemetry or requests to third parties. Model behavior and retention within Pico depend on your server setup.

Questions: [GitHub issues](https://github.com/takuomi/pico-ai-bridge/issues).

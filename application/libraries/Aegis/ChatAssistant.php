<?php
namespace Aegis;

/**
 * Public website assistant. It uses a configured OpenAI-compatible provider
 * when explicitly enabled and otherwise returns a safe product guide. The
 * fallback is intentional: everyone receives a useful response without
 * pretending that an AI provider or private account data exists.
 */
final class ChatAssistant
{
    private const SYSTEM = 'You are the WINDELS AI WORKFORCE website assistant. Explain only navigation and documented product features: the AI language teacher, language learning, trading intelligence, paper trading, sports intelligence, EuroMillions research, lead discovery and account access. Never reveal or link to the administrator login, never claim access to private records, never invent market, sports, lottery or business data, and say when a real provider or signed-in administrator is required. Keep replies concise and practical.';

    public function respond(string $message, ?array $user = null): array
    {
        $message = trim($message);
        if ($message === '' || mb_strlen($message) > 1000) throw new \InvalidArgumentException('message must contain 1–1000 characters');
        $configured = getenv('AI_CHAT_ENABLED') === '1' && trim((string) getenv('AI_CHAT_API_URL')) !== '' && trim((string) getenv('AI_CHAT_API_KEY')) !== '' && trim((string) getenv('AI_CHAT_MODEL')) !== '';
        if ($configured) {
            $answer = $this->providerAnswer($message);
            if ($answer !== null) return ['message' => $answer, 'provider' => 'configured-ai', 'grounded' => true, 'disclaimer' => 'Product guidance only; no private record data was provided to the assistant.'];
        }
        return ['message' => $this->localAnswer($message), 'provider' => 'local-guide', 'grounded' => true, 'disclaimer' => 'Product guidance only; configure an approved AI provider for generated responses.'];
    }

    private function localAnswer(string $message): string
    {
        $value = strtolower($message);
        if (str_contains($value, 'duplicate')) return 'Open Lead Discovery Intelligence to review duplicate candidates. Provider plus stable source ID is the primary identity rule; secondary signals require a human decision.';
        if (str_contains($value, 'export')) return 'Open Lead Discovery or Intelligence to create a formula-safe CSV/JSON export. Every export is recorded in the audit history.';
        if (str_contains($value, 'admin') || str_contains($value, 'administrator')) return 'WINDELS AI WORKFORCE only exposes the normal member sign-in publicly. Administrator controls are kept behind a private entry point and are never linked from the public site.';
        if (str_contains($value, 'user')) return 'Use the member sign-in to open your workspace. If you do not have an account yet, register on the homepage.';
        if (str_contains($value, 'search') || str_contains($value, 'lead')) return 'Open Lead Discovery to search a city, category or business type. A configured provider is required; empty provider results are never replaced with fake businesses.';
        if (str_contains($value, 'trade') || str_contains($value, 'paper')) return 'Trading defaults to analysis-only with the kill switch active. Paper trading is simulation and every order passes risk controls.';
        if (str_contains($value, 'language')) return 'Open Languages to create a profile, take an evidence-based assessment, study lessons and vocabulary, and review adaptive plans.';
        if (str_contains($value, 'lottery') || str_contains($value, 'euromillions')) return 'EuroMillions outputs describe historical observations only. Official data providers must be configured before official draws are ingested.';
        return 'I can guide you through the AI Language Teacher, Languages, Dashboard, Lead Discovery, Pipeline, Sports, EuroMillions, Trading and Account. Ask about any area.';
    }

    private function providerAnswer(string $message): ?string
    {
        $url = trim((string) getenv('AI_CHAT_API_URL')); $key = trim((string) getenv('AI_CHAT_API_KEY')); $model = trim((string) getenv('AI_CHAT_MODEL'));
        $body = json_encode(['model' => $model, 'messages' => [['role' => 'system', 'content' => self::SYSTEM], ['role' => 'user', 'content' => $message]], 'temperature' => 0.2, 'max_tokens' => 260], JSON_UNESCAPED_SLASHES);
        $context = stream_context_create(['http' => ['method' => 'POST', 'timeout' => 8, 'ignore_errors' => true, 'header' => "Accept: application/json\r\nContent-Type: application/json\r\nAuthorization: Bearer {$key}\r\n", 'content' => $body], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $raw = @file_get_contents($url, false, $context);
        if ($raw === false) return null;
        $payload = json_decode($raw, true);
        $answer = $payload['choices'][0]['message']['content'] ?? null;
        return is_string($answer) && trim($answer) !== '' ? mb_substr(trim($answer), 0, 2000) : null;
    }
}

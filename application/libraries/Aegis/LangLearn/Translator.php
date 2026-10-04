<?php
namespace Aegis\LangLearn;

/**
 * AI Language Teacher — phrase + word translator with source-language detection.
 *
 * Honesty model (consistent with the rest of the module): translations come
 * ONLY from an authored phrasebook and an authored word dictionary. When a
 * sentence is not covered, the service says so plainly and offers a
 * best-effort word-by-word pass labelled as an approximation — it never
 * fabricates a fluent machine translation.
 *
 * The phrasebook is symmetric: every concept lists the same meaning across
 * the languages it covers, so detection and translation use one source of
 * truth. Languages outside the phrasebook still benefit from Unicode-script
 * detection and registry-driven selection.
 */
final class Translator
{
    /** BCP-47 locale per ISO code — used to pick the correct TTS voice. */
    public const LOCALES = [
        'nl' => 'nl-NL', 'es' => 'es-ES', 'it' => 'it-IT', 'fr' => 'fr-FR',
        'de' => 'de-DE', 'en' => 'en-GB', 'pt' => 'pt-PT', 'ar' => 'ar-SA',
        'zh' => 'zh-CN', 'ja' => 'ja-JP', 'ko' => 'ko-KR', 'ru' => 'ru-RU',
        'hi' => 'hi-IN', 'tr' => 'tr-TR', 'sw' => 'sw-KE', 'yo' => 'yo-NG',
        'ig' => 'ig-NG', 'ha' => 'ha-NG', 'af' => 'af-ZA', 'zu' => 'zu-ZA',
    ];

    /**
     * Authored phrasebook. Keyed by a canonical English concept; each entry
     * maps ISO code => localized phrase. Several variants are listed where a
     * single English string has common alternatives so the matcher is forgiving.
     */
    private const PHRASES = [
        'good_morning' => [
            'en' => ['good morning', "good morning, how are you?", 'good morning, how are you'],
            'fr' => ['bonjour, comment allez-vous ?', 'bonjour, comment allez-vous', 'bonjour'],
            'es' => ['buenos días, ¿cómo estás?', 'buenos días, ¿cómo está usted?', 'buenos días'],
            'de' => ['guten morgen, wie geht es dir?', 'guten morgen, wie geht es ihnen?', 'guten morgen'],
            'it' => ['buongiorno, come stai?', 'buongiorno, come sta?', 'buongiorno'],
            'pt' => ['bom dia, como está?', 'bom dia, tudo bem?', 'bom dia'],
            'nl' => ['goedemorgen, hoe gaat het?', 'goedemorgen, hoe maakt u het?', 'goedemorgen'],
            'tr' => ['günaydın, nasılsın?', 'günaydın'],
            'sw' => ['habari za asubuhi, habari yako?', 'habari za asubuhi'],
        ],
        'hello' => [
            'en' => ['hello', 'hi'],
            'fr' => ['bonjour', 'salut'],
            'es' => ['hola'],
            'de' => ['hallo', 'servus'],
            'it' => ['ciao', 'salve'],
            'pt' => ['olá', 'oi'],
            'nl' => ['hallo', 'hoi'],
            'tr' => ['merhaba', 'selam'],
            'sw' => ['habari', 'hujambo'],
        ],
        'how_are_you' => [
            'en' => ['how are you?', 'how are you', "how are you doing?", 'how are you doing'],
            'fr' => ['comment allez-vous ?', 'comment allez-vous', 'comment vas-tu ?', 'comment vas-tu'],
            'es' => ['¿cómo estás?', 'cómo estás', '¿cómo está usted?', 'cómo está usted'],
            'de' => ['wie geht es dir?', 'wie geht es ihnen?'],
            'it' => ['come stai?', 'come sta?'],
            'pt' => ['como está?', 'tudo bem?'],
            'nl' => ['hoe gaat het?', 'hoe maakt u het?'],
            'tr' => ['nasılsın?', 'nasılsınız?'],
            'sw' => ['habari yako?', 'umetuje?'],
        ],
        'goodbye' => [
            'en' => ['goodbye', 'bye', 'see you', 'see you later'],
            'fr' => ['au revoir', 'à bientôt'],
            'es' => ['adiós', 'hasta luego', 'chao'],
            'de' => ['auf wiedersehen', 'tschüss', 'bis bald'],
            'it' => ['arrivederci', 'ciao', 'a presto'],
            'pt' => ['adeus', 'até logo', 'tchau'],
            'nl' => ['tot ziens', 'dag'],
            'tr' => ['hoşça kal', 'güle güle'],
            'sw' => ['kwaheri', 'tutaonana'],
        ],
        'thank_you' => [
            'en' => ['thank you', 'thanks', 'thank you very much'],
            'fr' => ['merci', 'merci beaucoup'],
            'es' => ['gracias', 'muchas gracias'],
            'de' => ['danke', 'vielen dank'],
            'it' => ['grazie', 'grazie mille'],
            'pt' => ['obrigado', 'obrigada', 'muito obrigado'],
            'nl' => ['dank je', 'dank u', 'bedankt'],
            'tr' => ['teşekkür ederim', 'teşekkürler'],
            'sw' => ['asante', 'asante sana'],
        ],
        'please' => [
            'en' => ['please'],
            'fr' => ["s'il vous plaît", 'sil vous plaît', "s'il te plaît"],
            'es' => ['por favor'],
            'de' => ['bitte'],
            'it' => ['per favore', 'per piacere'],
            'pt' => ['por favor'],
            'nl' => ['alstublieft', 'alsjeblieft'],
            'tr' => ['lütfen'],
            'sw' => ['tafadhali'],
        ],
        'yes' => [
            'en' => ['yes', 'yeah'],
            'fr' => ['oui'],
            'es' => ['sí', 'si'],
            'de' => ['ja'],
            'it' => ['sì', 'si'],
            'pt' => ['sim'],
            'nl' => ['ja'],
            'tr' => ['evet'],
            'sw' => ['ndiyo', 'naam'],
        ],
        'no' => [
            'en' => ['no'],
            'fr' => ['non'],
            'es' => ['no'],
            'de' => ['nein'],
            'it' => ['no'],
            'pt' => ['não', 'nao'],
            'nl' => ['nee'],
            'tr' => ['hayır', 'hayir'],
            'sw' => ['hapana', 'la'],
        ],
        'excuse_me' => [
            'en' => ['excuse me', 'sorry'],
            'fr' => ['excusez-moi', 'excusez moi', 'pardon'],
            'es' => ['disculpe', 'perdón', 'perdon'],
            'de' => ['entschuldigung', 'entschuldigen sie'],
            'it' => ['mi scusi', 'scusa'],
            'pt' => ['com licença', 'desculpe'],
            'nl' => ['pardon', 'neem me niet kwalijk'],
            'tr' => ['pardon', 'afedersiniz'],
            'sw' => ['samahani', 'pole'],
        ],
        'good_evening' => [
            'en' => ['good evening'],
            'fr' => ['bonsoir'],
            'es' => ['buenas noches', 'buenas tardes'],
            'de' => ['guten abend'],
            'it' => ['buonasera'],
            'pt' => ['boa noite', 'boa tarde'],
            'nl' => ['goedenavond'],
            'tr' => ['iyi akşamlar', 'iyi aksamlar'],
            'sw' => ['habari za jioni'],
        ],
        'what_is_your_name' => [
            'en' => ['what is your name?', "what's your name?", 'what is your name'],
            'fr' => ['comment vous appelez-vous ?', 'comment vous appelez-vous', 'comment tu t\'appelles ?'],
            'es' => ['¿cómo te llamas?', 'cómo te llamas', '¿cómo se llama usted?'],
            'de' => ['wie heißt du?', 'wie heißen sie?', 'wie heisst du?'],
            'it' => ['come ti chiami?', 'come si chiama?'],
            'pt' => ['como você se chama?', 'qual é o seu nome?'],
            'nl' => ['hoe heet je?', 'hoe heet u?'],
            'tr' => ['adın ne?', 'adınız ne?'],
            'sw' => ['jina lako nani?'],
        ],
        'my_name_is' => [
            'en' => ['my name is', "i'm", 'i am'],
            'fr' => ["je m'appelle", 'je m appelle'],
            'es' => ['me llamo', 'yo soy'],
            'de' => ['ich heiße', 'ich heisse', 'mein name ist'],
            'it' => ['mi chiamo'],
            'pt' => ['eu me chamo', 'meu nome é', 'meu nome e'],
            'nl' => ['ik heet', 'mijn naam is'],
            'tr' => ['benim adım', 'benim adim', 'adım', 'adim'],
            'sw' => ['jina langu ni'],
        ],
        'nice_to_meet_you' => [
            'en' => ['nice to meet you', 'pleased to meet you'],
            'fr' => ['enchanté', 'enchantée', 'ravi de vous rencontrer'],
            'es' => ['encantado', 'encantada', 'mucho gusto'],
            'de' => ['schön, dich kennenzulernen', 'freut mich'],
            'it' => ['piacere', 'piacere di conoscerti'],
            'pt' => ['prazer', 'muito prazer'],
            'nl' => ['aangenaam', 'leuk je te ontmoeten'],
            'tr' => ['tanıştığımıza memnun oldum', 'tanistigimiza memnun oldum', 'memnun oldum'],
            'sw' => ['ninafurahi kukutana na wewe'],
        ],
        'i_do_not_understand' => [
            'en' => ["i don't understand", 'i do not understand'],
            'fr' => ['je ne comprends pas'],
            'es' => ['no entiendo', 'no comprendo'],
            'de' => ['ich verstehe nicht'],
            'it' => ['non capisco', 'non comprendo'],
            'pt' => ['não entendo', 'nao entendo', 'não compreendo'],
            'nl' => ['ik begrijp het niet'],
            'tr' => ['anlamıyorum', 'anlamiyorum'],
            'sw' => ['sielewi'],
        ],
        'do_you_speak_english' => [
            'en' => ['do you speak english?'],
            'fr' => ['parlez-vous anglais ?', 'parlez-vous anglais', 'est-ce que vous parlez anglais ?'],
            'es' => ['¿hablas inglés?', 'hablas inglés', '¿habla inglés?'],
            'de' => ['sprichst du englisch?', 'sprechen sie englisch?'],
            'it' => ['parli inglese?', 'parla inglese?'],
            'pt' => ['você fala inglês?', 'voce fala ingles?'],
            'nl' => ['spreek je engels?', 'spreekt u engels?'],
            'tr' => ['ingilizce konuşuyor musun?', 'ingilizce konusuyor musun?'],
            'sw' => ['unaongea kiingereza?'],
        ],
        'where_is_the' => [
            'en' => ['where is', "where's", 'how do i get to'],
            'fr' => ['où est', 'ou est', 'où se trouve', 'ou se trouve'],
            'es' => ['¿dónde está', 'dónde está', '¿dónde está el', 'dónde está el'],
            'de' => ['wo ist', 'wo ist der', 'wo ist die'],
            'it' => ['dov\'è', 'dove è', 'dov\'è il', 'dove si trova'],
            'pt' => ['onde é', 'onde fica', 'onde está'],
            'nl' => ['waar is', 'waar is de', 'waar is het'],
            'tr' => ['nerede', 'nerede ...'],
            'sw' => ['wapi ...', 'iko wapi'],
        ],
        'how_much' => [
            'en' => ['how much is it?', 'how much', 'how much does it cost?'],
            'fr' => ['combien ça coûte ?', 'combien ca coute', 'combien ?', 'combien'],
            'es' => ['¿cuánto cuesta?', 'cuánto cuesta', '¿cuánto es?', 'cuánto es'],
            'de' => ['wie viel kostet das?', 'wieviel kostet das?', 'wie viel'],
            'it' => ['quanto costa?', 'quanto'],
            'pt' => ['quanto custa?', 'quanto é?', 'quanto e?'],
            'nl' => ['hoeveel kost het?', 'hoeveel'],
            'tr' => ['ne kadar?', 'bu ne kadar?'],
            'sw' => ['ni bei gani?', 'ni bei ngapi?'],
        ],
        'i_would_like' => [
            'en' => ['i would like', "i'd like", 'i want', 'can i have'],
            'fr' => ['je voudrais', 'j\'aimerais', 'j aimerais'],
            'es' => ['me gustaría', 'me gustaria', 'quiero'],
            'de' => ['ich möchte', 'ich hätte gern', 'ich mochte'],
            'it' => ['vorrei', 'mi piacerebbe'],
            'pt' => ['eu gostaria', 'eu quero'],
            'nl' => ['ik wil graag', 'ik zou willen'],
            'tr' => ['istiyorum', 'bir ... alabilir miyim'],
            'sw' => ['ningependa', 'nataka'],
        ],
        'the_bill' => [
            'en' => ['the bill, please', 'check, please', 'can i have the bill'],
            'fr' => ["l'addition, s'il vous plaît", 'l\'addition s\'il vous plaît', "l'addition"],
            'es' => ['la cuenta, por favor', 'la cuenta por favor'],
            'de' => ['die rechnung, bitte', 'die rechnung bitte'],
            'it' => ['il conto, per favore', 'il conto per favore'],
            'pt' => ['a conta, por favor', 'a conta por favor'],
            'nl' => ['de rekening, alstublieft', 'de rekening alstublieft'],
            'tr' => ['hesabı lütfen', 'hesabi lutfen'],
            'sw' => ['bili, tafadhali'],
        ],
        'i_love_you' => [
            'en' => ['i love you'],
            'fr' => ['je t\'aime', 'je t aime'],
            'es' => ['te quiero', 'te amo'],
            'de' => ['ich liebe dich'],
            'it' => ['ti amo', 'ti voglio bene'],
            'pt' => ['eu te amo', 'amo-te'],
            'nl' => ['ik hou van jou', 'ik hou van je'],
            'tr' => ['seni seviyorum'],
            'sw' => ['nakupenda'],
        ],
        'see_you_tomorrow' => [
            'en' => ['see you tomorrow'],
            'fr' => ['à demain', 'a demain'],
            'es' => ['hasta mañana', 'hasta manana'],
            'de' => ['bis morgen'],
            'it' => ['a domani'],
            'pt' => ['até amanhã', 'ate amanha'],
            'nl' => ['tot morgen'],
            'tr' => ['yarın görüşürüz', 'yarin gorusuruz'],
            'sw' => ['tuonane kesho'],
        ],
        'good_night' => [
            'en' => ['good night'],
            'fr' => ['bonne nuit'],
            'es' => ['buenas noches'],
            'de' => ['gute nacht'],
            'it' => ['buonanotte'],
            'pt' => ['boa noite'],
            'nl' => ['goedenacht', 'welterusten'],
            'tr' => ['iyi geceler'],
            'sw' => ['lala salama'],
        ],
    ];

    /** Authored single-word dictionary: English pivot → per-language word. */
    private const WORDS = [
        'good' => ['fr' => 'bon', 'es' => 'bueno', 'de' => 'gut', 'it' => 'buono', 'pt' => 'bom', 'nl' => 'goed', 'tr' => 'iyi', 'sw' => 'nzuri'],
        'morning' => ['fr' => 'matin', 'es' => 'mañana', 'de' => 'morgen', 'it' => 'mattina', 'pt' => 'manhã', 'nl' => 'ochtend', 'tr' => 'sabah', 'sw' => 'asubuhi'],
        'evening' => ['fr' => 'soir', 'es' => 'tarde', 'de' => 'abend', 'it' => 'sera', 'pt' => 'noite', 'nl' => 'avond', 'tr' => 'akşam', 'sw' => 'jioni'],
        'night' => ['fr' => 'nuit', 'es' => 'noche', 'de' => 'nacht', 'it' => 'notte', 'pt' => 'noite', 'nl' => 'nacht', 'tr' => 'gece', 'sw' => 'usiku'],
        'how' => ['fr' => 'comment', 'es' => 'cómo', 'de' => 'wie', 'it' => 'come', 'pt' => 'como', 'nl' => 'hoe', 'tr' => 'nasıl', 'sw' => 'vipi'],
        'are' => ['fr' => 'allez/êtes', 'es' => 'estás', 'de' => 'bist/sind', 'it' => 'stai', 'pt' => 'está', 'nl' => 'gaat/bent', 'tr' => '—', 'sw' => '—'],
        'you' => ['fr' => 'vous', 'es' => 'tú/usted', 'de' => 'du/sie', 'it' => 'tu/lei', 'pt' => 'você', 'nl' => 'je/u', 'tr' => 'sen/siz', 'sw' => 'wewe'],
        'the' => ['fr' => 'le/la', 'es' => 'el/la', 'de' => 'der/die', 'it' => 'il/la', 'pt' => 'o/a', 'nl' => 'de/het', 'tr' => '—', 'sw' => '—'],
        'water' => ['fr' => "l'eau", 'es' => 'agua', 'de' => 'wasser', 'it' => 'acqua', 'pt' => 'água', 'nl' => 'water', 'tr' => 'su', 'sw' => 'maji'],
        'food' => ['fr' => 'nourriture', 'es' => 'comida', 'de' => 'essen', 'it' => 'cibo', 'pt' => 'comida', 'nl' => 'eten', 'tr' => 'yemek', 'sw' => 'chakula'],
        'coffee' => ['fr' => 'café', 'es' => 'café', 'de' => 'kaffee', 'it' => 'caffè', 'pt' => 'café', 'nl' => 'koffie', 'tr' => 'kahve', 'sw' => 'kahawa'],
        'tea' => ['fr' => 'thé', 'es' => 'té', 'de' => 'tee', 'it' => 'tè', 'pt' => 'chá', 'nl' => 'thee', 'tr' => 'çay', 'sw' => 'chai'],
        'friend' => ['fr' => 'ami', 'es' => 'amigo', 'de' => 'freund', 'it' => 'amico', 'pt' => 'amigo', 'nl' => 'vriend', 'tr' => 'arkadaş', 'sw' => 'rafiki'],
        'house' => ['fr' => 'maison', 'es' => 'casa', 'de' => 'haus', 'it' => 'casa', 'pt' => 'casa', 'nl' => 'huis', 'tr' => 'ev', 'sw' => 'nyumba'],
        'school' => ['fr' => 'école', 'es' => 'escuela', 'de' => 'schule', 'it' => 'scuola', 'pt' => 'escola', 'nl' => 'school', 'tr' => 'okul', 'sw' => 'shule'],
        'book' => ['fr' => 'livre', 'es' => 'libro', 'de' => 'buch', 'it' => 'libro', 'pt' => 'livro', 'nl' => 'boek', 'tr' => 'kitap', 'sw' => 'kitabu'],
        'one' => ['fr' => 'un', 'es' => 'uno', 'de' => 'eins', 'it' => 'uno', 'pt' => 'um', 'nl' => 'één', 'tr' => 'bir', 'sw' => 'moja'],
        'two' => ['fr' => 'deux', 'es' => 'dos', 'de' => 'zwei', 'it' => 'due', 'pt' => 'dois', 'nl' => 'twee', 'tr' => 'iki', 'sw' => 'mbili'],
        'three' => ['fr' => 'trois', 'es' => 'tres', 'de' => 'drei', 'it' => 'tre', 'pt' => 'três', 'nl' => 'drie', 'tr' => 'üç', 'sw' => 'tatu'],
        'yes' => ['fr' => 'oui', 'es' => 'sí', 'de' => 'ja', 'it' => 'sì', 'pt' => 'sim', 'nl' => 'ja', 'tr' => 'evet', 'sw' => 'ndiyo'],
        'no' => ['fr' => 'non', 'es' => 'no', 'de' => 'nein', 'it' => 'no', 'pt' => 'não', 'nl' => 'nee', 'tr' => 'hayır', 'sw' => 'hapana'],
        'big' => ['fr' => 'grand', 'es' => 'grande', 'de' => 'groß', 'it' => 'grande', 'pt' => 'grande', 'nl' => 'groot', 'tr' => 'büyük', 'sw' => 'kubwa'],
        'small' => ['fr' => 'petit', 'es' => 'pequeño', 'de' => 'klein', 'it' => 'piccolo', 'pt' => 'pequeno', 'nl' => 'klein', 'tr' => 'küçük', 'sw' => 'dogo'],
        'today' => ['fr' => "aujourd'hui", 'es' => 'hoy', 'de' => 'heute', 'it' => 'oggi', 'pt' => 'hoje', 'nl' => 'vandaag', 'tr' => 'bugün', 'sw' => 'leo'],
        'tomorrow' => ['fr' => 'demain', 'es' => 'mañana', 'de' => 'morgen', 'it' => 'domani', 'pt' => 'amanhã', 'nl' => 'morgen', 'tr' => 'yarın', 'sw' => 'kesho'],
        'love' => ['fr' => 'amour', 'es' => 'amor', 'de' => 'liebe', 'it' => 'amore', 'pt' => 'amor', 'nl' => 'liefde', 'tr' => 'aşk', 'sw' => 'upendo'],
        'time' => ['fr' => 'temps', 'es' => 'tiempo', 'de' => 'zeit', 'it' => 'tempo', 'pt' => 'tempo', 'nl' => 'tijd', 'tr' => 'zaman', 'sw' => 'wakati'],
        'day' => ['fr' => 'jour', 'es' => 'día', 'de' => 'tag', 'it' => 'giorno', 'pt' => 'dia', 'nl' => 'dag', 'tr' => 'gün', 'sw' => 'siku'],
        'yes_please' => ['fr' => 'oui', 'es' => 'sí', 'de' => 'ja bitte', 'it' => 'sì', 'pt' => 'sim', 'nl' => 'ja', 'tr' => 'evet', 'sw' => 'ndiyo'],
    ];

    /** Reverse index of every phrase variant → [concept, lang]; built lazily. */
    private static ?array $phraseIndex = null;
    /** Reverse index of single words → [word, lang]; built lazily. */
    private static ?array $wordIndex = null;

    public function localeFor(string $code): string
    {
        return self::LOCALES[strtolower(trim($code))] ?? strtolower(trim($code));
    }

    /** Registry-driven language list for the UI selector. */
    public function languages(): array
    {
        return LanguageRegistry::all();
    }

    public function languageName(string $code): string
    {
        $code = strtolower(trim($code));
        $lang = LanguageRegistry::get($code);
        return $lang['name'] ?? strtoupper($code);
    }

    /**
     * Detect the source language of a piece of text.
     * @return array{code:?string,name:?string,method:?string,confidence:float}
     */
    public function detect(string $text): array
    {
        $text = $this->normalize($text);
        if ($text === '') {
            return ['code' => null, 'name' => null, 'method' => null, 'confidence' => 0.0];
        }

        // 1) Exact / leading phrase match — strongest signal.
        $hit = $this->findPhrase($text);
        if ($hit !== null) {
            return ['code' => $hit['lang'], 'name' => $this->languageName($hit['lang']), 'method' => 'phrase', 'confidence' => 0.95];
        }

        // 2) Word-dictionary vote.
        $vote = $this->voteByWords($text);
        if ($vote['code'] !== null && $vote['confidence'] >= 0.5) {
            return ['code' => $vote['code'], 'name' => $this->languageName($vote['code']), 'method' => 'dictionary', 'confidence' => $vote['confidence']];
        }

        // 3) Unicode script — works even without dictionary coverage.
        $script = $this->detectByScript($text);
        if ($script !== null) {
            return ['code' => $script, 'name' => $this->languageName($script), 'method' => 'script', 'confidence' => 0.7];
        }

        return ['code' => null, 'name' => null, 'method' => null, 'confidence' => 0.0];
    }

    /**
     * Translate text into the target language, auto-detecting the source when
     * none is supplied. Always returns a structured result with an honest note.
     */
    public function translate(string $text, string $target, ?string $source = null): array
    {
        $target = strtolower(trim($target));
        $text = trim($text);
        if ($text === '') {
            throw new \InvalidArgumentException('text must not be empty');
        }
        if (!LanguageRegistry::get($target)) {
            throw new \InvalidArgumentException("unsupported target language: {$target}");
        }

        $detected = $this->detect($text);
        $source = $source !== null ? strtolower(trim($source)) : ($detected['code'] ?? 'en');
        $sourceName = $this->languageName($source);
        $targetName = $this->languageName($target);

        $base = [
            'source' => $source,
            'sourceName' => $sourceName,
            'target' => $target,
            'targetName' => $targetName,
            'targetLocale' => $this->localeFor($target),
            'detected' => $detected,
            'translation' => null,
            'method' => null,
            'note' => null,
            'romanization' => null,
        ];

        if ($source === $target) {
            $base['translation'] = $text;
            $base['method'] = 'same-language';
            $base['note'] = 'Source and target are the same language — the text is shown unchanged.';
            return $base;
        }

        // Segment-based translation: walk the text, matching the longest known
        // phrase at each position, then falling back to single-word lookup.
        $seg = $this->segment($text, $source, $target);
        if ($seg !== null && $seg['covered']) {
            $base['translation'] = $seg['text'];
            $base['method'] = $seg['method'];
            $base['note'] = $seg['method'] === 'phrasebook'
                ? 'Translated from the authored phrasebook.'
                : ($seg['method'] === 'word-by-word'
                    ? 'Approximation: each word was looked up in the dictionary and joined in order. Word order and grammar may not be natural in ' . $targetName . '.'
                    : 'Translated from the phrasebook where phrases matched, with a word-by-word pass for the rest.');
            return $base;
        }

        // Honest fallback — never fabricate.
        $base['translation'] = null;
        $base['method'] = 'none';
        $base['note'] = 'This sentence is not in the authored phrasebook or dictionary yet, so no fluent translation is available. Try a shorter sentence, a common greeting, or single words.';
        return $base;
    }

    // ------------------------------------------------------------- internals

    /**
     * Greedy segment translator. Matches the longest source-language phrase at
     * the current position, otherwise consumes one token via the dictionary.
     * Returns null only when nothing could be covered at all.
     * @return array{text:string,method:string,covered:bool}|null
     */
    private function segment(string $text, string $source, string $target): ?array
    {
        $this->ensurePhraseIndex();
        $this->ensureWordIndex();
        $norm = $this->normalize($text);
        if ($norm === '') return null;

        $sourcePhrases = $this->sourcePhrases($source);
        $pieces = [];
        $best = 0; // 0 none, 1 word, 2 phrase
        $covered = 0;
        $cursor = 0;
        $len = mb_strlen($norm, 'UTF-8');

        while ($cursor < $len) {
            $cursor = $this->skipSpaces($norm, $cursor);
            if ($cursor >= $len) break;

            // 1) Longest phrasebook phrase starting at the cursor (word-bounded).
            foreach ($sourcePhrases as $entry) {
                $variant = $entry[0];
                $vlen = mb_strlen($variant, 'UTF-8');
                if (mb_substr($norm, $cursor, $vlen, 'UTF-8') !== $variant) continue;
                $after = mb_substr($norm, $cursor + $vlen, 1, 'UTF-8');
                if ($after !== '' && $after !== ' ' && $after !== ',' && $after !== '.' && $after !== '?' && $after !== '!' && $after !== ';') continue;
                $t = $this->bestPhrase($entry[1], $target, $vlen);
                if ($t !== null) {
                    $pieces[] = $t; $cursor += $vlen; $best = max($best, 2); $covered++;
                    continue 2;
                }
            }

            // 2) Single token via the dictionary.
            $next = mb_strpos($norm, ' ', $cursor);
            $tok = $next === false ? mb_substr($norm, $cursor, null, 'UTF-8') : mb_substr($norm, $cursor, $next - $cursor, 'UTF-8');
            $tok = trim($tok);
            if ($tok === '') { $cursor++; continue; }
            $en = $this->pivotWord($tok, $source);
            if ($en !== null && isset(self::WORDS[$en][$target]) && self::WORDS[$en][$target] !== '—') {
                $pieces[] = self::WORDS[$en][$target];
                $best = max($best, 1); $covered++;
            } else {
                $pieces[] = $tok; // keep the original token (honest, not invented)
            }
            $cursor += mb_strlen($tok, 'UTF-8');
        }

        if ($covered === 0) return null;
        // Label honestly: any phrasebook hit reads as a phrasebook translation;
        // a pure dictionary pass reads as a word-by-word approximation.
        $method = $best === 1 ? 'word-by-word' : 'phrasebook';
        return ['text' => implode(' ', $pieces), 'method' => $method, 'covered' => $covered > 0];
    }

    /** Normalized source-language phrasebook variants, longest first: [variant, concept]. */
    private function sourcePhrases(string $source): array
    {
        $this->ensurePhraseIndex();
        $out = [];
        foreach (self::$phraseIndex as $variant => $matches) {
            foreach ($matches as $m) {
                if ($m['lang'] === $source) { $out[] = [$variant, $m['concept']]; break; }
            }
        }
        usort($out, fn($a, $b) => mb_strlen($b[0], 'UTF-8') <=> mb_strlen($a[0], 'UTF-8'));
        return $out;
    }

    /** Pick the target-language variant of a concept closest in length to the source phrase. */
    private function bestPhrase(string $concept, string $target, int $sourceLen): ?string
    {
        $variants = self::PHRASES[$concept][$target] ?? null;
        if (!$variants) return null;
        usort($variants, fn($a, $b) => abs(mb_strlen($a, 'UTF-8') - $sourceLen) <=> abs(mb_strlen($b, 'UTF-8') - $sourceLen));
        return $variants[0];
    }

    private function skipSpaces(string $text, int $pos): int
    {
        while ($pos < mb_strlen($text, 'UTF-8') && mb_substr($text, $pos, 1, 'UTF-8') === ' ') $pos++;
        return $pos;
    }

    private function normalize(string $text): string
    {
        $text = mb_strtolower($text, 'UTF-8');
        $text = preg_replace('/\s+/u', ' ', $text);
        return trim($text);
    }

    private function ensurePhraseIndex(): void
    {
        if (self::$phraseIndex !== null) return;
        $idx = [];
        foreach (self::PHRASES as $concept => $byLang) {
            foreach ($byLang as $lang => $variants) {
                foreach ((array) $variants as $v) {
                    $v = $this->normalize($v);
                    if ($v === '') continue;
                    $idx[$v][] = ['concept' => $concept, 'lang' => $lang];
                }
            }
        }
        // Longest first so "good morning, how are you?" wins over "good morning".
        uksort($idx, fn($a, $b) => mb_strlen($b, 'UTF-8') <=> mb_strlen($a, 'UTF-8'));
        self::$phraseIndex = $idx;
    }

    private function ensureWordIndex(): void
    {
        if (self::$wordIndex !== null) return;
        $idx = [];
        foreach (self::WORDS as $en => $byLang) {
            $idx[$en][] = ['word' => $en, 'lang' => 'en'];
            foreach ($byLang as $lang => $word) {
                if ($word === '—' || $word === '') continue;
                foreach (preg_split('/[\/]/', (string) $word) as $w) {
                    $w = $this->normalize($w);
                    if ($w === '') continue;
                    $idx[$w][] = ['word' => $en, 'lang' => $lang];
                }
            }
        }
        self::$wordIndex = $idx;
    }

    /** Find the longest phrasebook variant that the text equals or starts with. */
    private function findPhrase(string $text): ?array
    {
        $this->ensurePhraseIndex();
        foreach (self::$phraseIndex as $variant => $matches) {
            if ($text === $variant || str_starts_with($text, $variant)) {
                return $matches[0];
            }
        }
        return null;
    }

    private function voteByWords(string $text): array
    {
        $this->ensureWordIndex();
        $tokens = $this->tokens($text);
        if (!$tokens) return ['code' => null, 'confidence' => 0.0];
        $counts = [];
        $matched = 0;
        foreach ($tokens as $tok) {
            if (!isset(self::$wordIndex[$tok])) continue;
            $matched++;
            foreach (self::$wordIndex[$tok] as $entry) {
                $counts[$entry['lang']] = ($counts[$entry['lang']] ?? 0) + 1;
            }
        }
        if (!$counts) return ['code' => null, 'confidence' => 0.0];
        arsort($counts);
        $top = array_key_first($counts);
        $confidence = $matched > 0 ? ($counts[$top] / count($tokens)) : 0.0;
        return ['code' => $top, 'confidence' => round($confidence, 2)];
    }

    /**
     * Map a localized token to its English pivot word using the word index.
     * Only a same-language match is accepted — a token from another language
     * must not masquerade as the source (e.g. the Portuguese article "a" must
     * not be read as an English word).
     */
    private function pivotWord(string $token, string $source): ?string
    {
        $this->ensureWordIndex();
        if (isset(self::$wordIndex[$token])) {
            foreach (self::$wordIndex[$token] as $entry) {
                if ($entry['lang'] === $source) return $entry['word'];
            }
        }
        return null;
    }

    private function tokens(string $text): array
    {
        $text = preg_replace('/[^\p{L}\p{N}\s\']+/u', ' ', $text);
        $tokens = preg_split('/\s+/u', $text, -1, PREG_SPLIT_NO_EMPTY);
        return $tokens ?: [];
    }

    /** Detect language from Unicode script ranges for non-Latin languages. */
    private function detectByScript(string $text): ?string
    {
        if (preg_match('/[\x{0600}-\x{06FF}]/u', $text)) return 'ar';
        if (preg_match('/[\x{4E00}-\x{9FFF}]/u', $text)) return 'zh';
        if (preg_match('/[\x{3040}-\x{30FF}]/u', $text)) return 'ja';
        if (preg_match('/[\x{AC00}-\x{D7AF}]/u', $text)) return 'ko';
        if (preg_match('/[\x{0400}-\x{04FF}]/u', $text)) return 'ru';
        if (preg_match('/[\x{0900}-\x{097F}]/u', $text)) return 'hi';
        return null;
    }
}

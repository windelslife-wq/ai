<?php
namespace Aegis\LangLearn;

/**
 * AI TEACHER CONTENT (Phase 2) — authored phrase packs, writing tasks,
 * conversation scenarios and lesson frames.
 *
 * Everything here is real authored content matched with real deterministic
 * checks. What the engine can verify, it verifies (phrase patterns, required
 * task elements, bank answers). What it cannot verify (free-form grammar
 * quality, pronunciation) is explicitly labeled as needing a provider —
 * never invented.
 */
final class TeacherContent
{
    /** Per-language phrase packs (lowercase substring patterns, case-insensitive). */
    public const PHRASES = [
        'nl' => ['greet' => ['hallo', 'hoi', 'goedemorgen', 'goedemiddag', 'goedenavond'], 'name' => ['ik heet', 'mijn naam is'], 'thanks' => ['dank je', 'dank u', 'bedankt', 'dank'], 'bye' => ['tot ziens', 'doei', 'tot'], 'well' => ['het gaat goed', 'goed', 'prima'], 'please' => ['alsjeblieft', 'alstublieft'], 'origin' => ['ik kom uit', 'ik woon in']],
        'es' => ['greet' => ['hola', 'buenos días', 'buenas tardes', 'buenas noches'], 'name' => ['me llamo', 'mi nombre es'], 'thanks' => ['gracias'], 'bye' => ['adiós', 'adios', 'hasta luego', 'chao'], 'well' => ['estoy bien', 'muy bien', 'bien'], 'please' => ['por favor'], 'origin' => ['soy de', 'vivo en']],
        'fr' => ['greet' => ['bonjour', 'bonsoir', 'salut'], 'name' => ["je m'appelle", 'mon nom est'], 'thanks' => ['merci'], 'bye' => ['au revoir'], 'well' => ['ça va bien', 'ca va bien', 'je vais bien', 'très bien', 'tres bien', 'bien'], 'please' => ["s'il vous plaît", "s'il te plaît", 'sil vous plait'], 'origin' => ['je viens de', "j'habite", 'jhabite']],
        'de' => ['greet' => ['hallo', 'guten tag', 'guten morgen', 'guten abend'], 'name' => ['ich heiße', 'ich heisse', 'mein name ist'], 'thanks' => ['danke'], 'bye' => ['auf wiedersehen', 'tschüss', 'tschuss'], 'well' => ['mir geht es gut', 'sehr gut', 'gut'], 'please' => ['bitte'], 'origin' => ['ich komme aus', 'ich wohne in']],
        'it' => ['greet' => ['ciao', 'buongiorno', 'buonasera'], 'name' => ['mi chiamo', 'il mio nome è'], 'thanks' => ['grazie'], 'bye' => ['arrivederci'], 'well' => ['sto bene', 'molto bene', 'bene'], 'please' => ['per favore'], 'origin' => ['sono di', 'vivo a', 'vivo in']],
        'pt' => ['greet' => ['olá', 'ola', 'bom dia', 'boa tarde', 'boa noite'], 'name' => ['chamo-me', 'chamo me', 'meu nome é', 'o meu nome é'], 'thanks' => ['obrigado', 'obrigada'], 'bye' => ['adeus', 'tchau', 'até logo', 'ate logo'], 'well' => ['estou bem', 'muito bem', 'bem'], 'please' => ['por favor'], 'origin' => ['sou de', 'moro em', 'moro no']],
        'en' => ['greet' => ['hello', 'hi', 'good morning', 'good evening'], 'name' => ['my name is', "i'm", 'i am'], 'thanks' => ['thank you', 'thanks'], 'bye' => ['goodbye', 'bye', 'see you'], 'well' => ["i'm fine", "i'm good", 'very well', 'fine'], 'please' => ['please'], 'origin' => ["i'm from", 'i live in', 'i come from']],
        'sw' => ['greet' => ['habari', 'jambo', 'mambo', 'shikamoo'], 'name' => ['jina langu'], 'thanks' => ['asante'], 'bye' => ['kwaheri'], 'well' => ['niko vizuri', 'mzuri', 'salam'], 'please' => ['tafadhali'], 'origin' => ['ninatoka', 'natoka']],
        'yo' => ['greet' => ['báwo ni', 'bawo ni', 'ẹ kú', 'e kú', 'pẹlẹ', 'pẹ́lẹ́'], 'name' => ['orúkọ mi', 'oruko mi', 'mo n je'], 'thanks' => ['ẹ ṣe', 'e se', 'o ṣe', 'o se'], 'bye' => ['ọ dàbọ̀', 'o dabo'], 'well' => ['mo wà dáadáa', 'mo wa daadaa', 'dáadáa', 'daadaa'], 'please' => ['jọ̀wọ́', 'jowo'], 'origin' => ['mo wá láti', 'mo wa lati', 'mo n gbé', 'mo n gbe']],
        'ig' => ['greet' => ['ndewo', 'kedu'], 'name' => ['aha m', 'a ha m'], 'thanks' => ['daalụ', 'daalu'], 'bye' => ['ka ọ dị', 'ka o di'], 'well' => ['ọ dị m mma', 'o di m mma', 'di m mma'], 'please' => ['biko'], 'origin' => ['m si', 'esi m', 'm bi']],
        'ha' => ['greet' => ['sannu', 'barka da zuwa'], 'name' => ['sunana', 'sunan na'], 'thanks' => ['na gode'], 'bye' => ['sai anjima', 'sai wata rana', 'bai'], 'well' => ['na lafiya', 'lafiya lau', 'lafiya'], 'please' => ['don allah'], 'origin' => ['na zo daga', 'ina zaune']],
        'af' => ['greet' => ['hallo', 'goeie dag', 'goeie more'], 'name' => ['my naam is', 'ek is'], 'thanks' => ['dankie'], 'bye' => ['totsiens'], 'well' => ['ek is goed', 'goed'], 'please' => ['asseblief'], 'origin' => ['ek kom uit', 'ek woon in']],
        'zu' => ['greet' => ['sawubona', 'sanibonani'], 'name' => ['igama lami'], 'thanks' => ['ngiyabonga'], 'bye' => ['hamba kahle', 'sala kahle'], 'well' => ['ngisaphila', 'ngiyaphila'], 'please' => ['ngiyacela'], 'origin' => ['ngivela', 'ngihlala']],
        'ar' => ['greet' => ['مرحبا', 'أهلا', 'اهلا', 'السلام عليكم'], 'name' => ['اسمي'], 'thanks' => ['شكرا'], 'bye' => ['مع السلامة'], 'well' => ['بخير', 'أنا بخير'], 'please' => ['من فضلك'], 'origin' => ['أنا من']],
        'zh' => ['greet' => ['你好', '您好', '大家好'], 'name' => ['我叫', '我的名字是'], 'thanks' => ['谢谢'], 'bye' => ['再见', '拜拜'], 'well' => ['我很好', '很好'], 'please' => ['请'], 'origin' => ['我来自', '我住在']],
        'ja' => ['greet' => ['こんにちは', 'はじめまして', 'おはよう'], 'name' => ['私は', '僕は', '名前は'], 'thanks' => ['ありがとう'], 'bye' => ['さようなら', 'またね'], 'well' => ['元気です', 'おかげさまで'], 'please' => ['お願いします'], 'origin' => ['から来ました', '住んでいます']],
        'ko' => ['greet' => ['안녕하세요', '안녕'], 'name' => ['저는', '제 이름은'], 'thanks' => ['감사합니다', '고맙습니다'], 'bye' => ['안녕히 가세요', '안녕'], 'well' => ['잘 지내요', '좋아요'], 'please' => ['주세요', '부탁합니다'], 'origin' => ['에서 왔어요', '살아요']],
        'ru' => ['greet' => ['привет', 'здравствуйте'], 'name' => ['меня зовут', 'мое имя', 'моё имя'], 'thanks' => ['спасибо'], 'bye' => ['до свидания', 'пока'], 'well' => ['хорошо', 'я в порядке', 'нормально'], 'please' => ['пожалуйста'], 'origin' => ['я из', 'живу в']],
        'hi' => ['greet' => ['नमस्ते', 'नमस्कार'], 'name' => ['मेरा नाम', 'मैं'], 'thanks' => ['धन्यवाद'], 'bye' => ['अलविदा', 'फिर मिलेंगे'], 'well' => ['ठीक हूँ', 'मैं ठीक', 'ठीक'], 'please' => ['कृपया'], 'origin' => ['से हूँ', 'मैं रहता']],
        'tr' => ['greet' => ['merhaba', 'selam', 'günaydın'], 'name' => ['benim adım', 'adım', 'ben'], 'thanks' => ['teşekkürler', 'teşekkür ederim'], 'bye' => ['hoşça kal', 'görüşürüz'], 'well' => ['iyiyim', 'çok iyiyim'], 'please' => ['lütfen'], 'origin' => ['geliyorum', 'yaşıyorum']],
    ];

    /** Drinks for the cafe scenario (only where confidently authored). */
    public const DRINKS = [
        'nl' => ['koffie', 'thee'], 'es' => ['café', 'cafe', 'té', 'te'], 'fr' => ['café', 'thé', 'the'],
        'de' => ['kaffee', 'tee'], 'it' => ['caffè', 'caffe', 'tè', 'te'], 'pt' => ['café', 'cafe', 'chá', 'cha'],
        'en' => ['coffee', 'tea'], 'sw' => ['kahawa', 'chai'], 'af' => ['koffie', 'tee'],
    ];

    /** Guided writing tasks per language (deterministic element checks). */
    public static function writingTasks(string $lang): array
    {
        $ph = self::PHRASES[$lang] ?? null;
        if (!$ph) return [];
        return [
            [
                'code' => 'self-introduction',
                'title' => 'Introduce yourself',
                'instruction' => 'Write 1–3 sentences introducing yourself: greet the reader and say your name. (Bonus: say where you are from.)',
                'required' => [['element' => 'a greeting', 'patterns' => $ph['greet']], ['element' => 'your name (e.g. a "my name is" phrase)', 'patterns' => $ph['name']]],
                'bonus' => [['element' => 'where you are from / live', 'patterns' => $ph['origin']]],
                'checkedNote' => 'Structured feedback covers the required elements above (real pattern checks). Full free-form grammar correction needs the writing-correction provider (not configured) — it is never simulated.',
            ],
            [
                'code' => 'thank-you-note',
                'title' => 'A short thank-you note',
                'instruction' => 'Write a short thank-you note: thank the person and say goodbye.',
                'required' => [['element' => 'a thank-you phrase', 'patterns' => $ph['thanks']], ['element' => 'a goodbye phrase', 'patterns' => $ph['bye']]],
                'bonus' => [],
                'checkedNote' => 'Checked elements: thanking + goodbye. Free-form style comments are not invented.',
            ],
        ];
    }

    /** Structured conversation drills (turn = instruction + accepted patterns). */
    public static function conversations(string $lang): array
    {
        $ph = self::PHRASES[$lang] ?? null;
        if (!$ph) return [];
        $scenarios = [
            [
                'code' => 'first-meeting', 'title' => 'First meeting (A1)', 'mode' => 'beginner',
                'aiOpeners' => [self::aiLine($lang, 'greet'), ''],
                'turns' => [
                    ['instruction' => 'Greet your new acquaintance.', 'element' => 'a greeting', 'patterns' => $ph['greet'], 'example' => $ph['greet'][0] ?? ''],
                    ['instruction' => 'Tell them your name.', 'element' => 'a "my name is" phrase', 'patterns' => $ph['name'], 'example' => $ph['name'][0] ?? ''],
                    ['instruction' => 'Say how you are doing.', 'element' => 'a "I am well" phrase', 'patterns' => $ph['well'], 'example' => $ph['well'][0] ?? ''],
                    ['instruction' => 'Thank them and say goodbye (use both a thank-you and a goodbye).', 'element' => 'thank-you AND goodbye', 'patterns' => array_merge($ph['thanks'], $ph['bye']), 'requireAll' => ['thanks' => $ph['thanks'], 'bye' => $ph['bye']], 'example' => ($ph['thanks'][0] ?? '') . ' … ' . ($ph['bye'][0] ?? '')],
                ],
            ],
        ];
        if (isset(self::DRINKS[$lang])) {
            $scenarios[] = [
                'code' => 'cafe', 'title' => 'At the café (A1)', 'mode' => 'restaurant',
                'aiOpeners' => [self::aiLine($lang, 'greet'), ''],
                'turns' => [
                    ['instruction' => 'Greet the barista.', 'element' => 'a greeting', 'patterns' => $ph['greet'], 'example' => $ph['greet'][0] ?? ''],
                    ['instruction' => 'Order a coffee or a tea — politely (include a please-word).', 'element' => 'drink + polite word', 'patterns' => array_merge(self::DRINKS[$lang], $ph['please']), 'requireAll' => ['drink' => self::DRINKS[$lang], 'please' => $ph['please']], 'example' => self::DRINKS[$lang][0] . ' + ' . $ph['please'][0]],
                    ['instruction' => 'Thank them.', 'element' => 'a thank-you phrase', 'patterns' => $ph['thanks'], 'example' => $ph['thanks'][0] ?? ''],
                ],
            ];
        }
        return $scenarios;
    }

    private static function aiLine(string $lang, string $kind): string
    {
        return self::PHRASES[$lang][$kind][0] ?? '';
    }

    /** Lesson frames per curriculum module code ({lang} is replaced). */
    public const LESSON_FRAMES = [
        'greetings' => ['goal' => 'Recognize and produce basic greetings', 'teach' => 'In {lang}, greetings depend on the time of day and formality. Study the examples below — each comes from this language\'s verified bank — then practice.'],
        'numbers-basics' => ['goal' => 'Recognize numbers and everyday basics', 'teach' => 'Numbers are the backbone of shopping, times and prices. Study the examples, then practice.'],
        'simple-sentences' => ['goal' => 'Build your first sentences', 'teach' => 'Simple sentences follow the language\'s basic word order with the verb matching the subject. The examples show correct forms.'],
        'first-readings' => ['goal' => 'Read your first short texts', 'teach' => 'Short readings use the phrases you already know: names, cities, ages. Read carefully and answer.'],
        'people-places' => ['goal' => 'Talk about people, family and places', 'teach' => 'People and places need everyday nouns plus the right articles. Study the examples, then practice.'],
        'present-tense' => ['goal' => 'Describe everyday actions', 'teach' => 'Everyday actions use the present tense; verbs change with the person. The examples show the correct present-tense forms.'],
        'possession' => ['goal' => 'Say whose it is', 'teach' => 'Possession is usually marked with a small function word (like "of" or an article change). The examples show the correct forms.'],
        'daily-life' => ['goal' => 'Read about daily life', 'teach' => 'Daily-life readings combine greetings, times and places. Read carefully and answer.'],
        'past-tense' => ['goal' => 'Talk about the past', 'teach' => 'The past tense changes the verb form. The examples show correct past forms for common verbs.'],
        'conditionals' => ['goal' => 'Express conditions and wishes', 'teach' => 'Conditions use a special verb mood in the result or the if-clause. The examples show the correct forms.'],
        'opinions' => ['goal' => 'Share opinions and read longer texts', 'teach' => 'Opinions combine connectors with everyday vocabulary. Read carefully and answer.'],
    ];
}

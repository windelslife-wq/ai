import { LanguageRegistry } from "./registry.js";

/**
 * AI Language Learning — TeacherContent, VocabularyBank, and Translator.
 * Port of application/libraries/Aegis/LangLearn/{TeacherContent,VocabularyBank,Translator}.php
 */

export const TeacherContent = {
  PHRASES: Object.freeze({
    nl: { greet: ["hallo", "hoi", "goedemorgen", "goedemiddag", "goedenavond"], name: ["ik heet", "mijn naam is"], thanks: ["dank je", "dank u", "bedankt", "dank"], bye: ["tot ziens", "doei", "tot"], well: ["het gaat goed", "goed", "prima"], please: ["alsjeblieft", "alstublieft"], origin: ["ik kom uit", "ik woon in"] },
    es: { greet: ["hola", "buenos días", "buenas tardes", "buenas noches"], name: ["me llamo", "mi nombre es"], thanks: ["gracias"], bye: ["adiós", "adios", "hasta luego", "chao"], well: ["estoy bien", "muy bien", "bien"], please: ["por favor"], origin: ["soy de", "vivo en"] },
    fr: { greet: ["bonjour", "bonsoir", "salut"], name: ["je m'appelle", "mon nom est"], thanks: ["merci"], bye: ["au revoir"], well: ["ça va bien", "ca va bien", "je vais bien", "très bien", "tres bien", "bien"], please: ["s'il vous plaît", "s'il te plaît", "sil vous plait"], origin: ["je viens de", "j'habite", "jhabite"] },
    de: { greet: ["hallo", "guten tag", "guten morgen", "guten abend"], name: ["ich heiße", "ich heisse", "mein name ist"], thanks: ["danke"], bye: ["auf wiedersehen", "tschüss", "tschuss"], well: ["mir geht es gut", "sehr gut", "gut"], please: ["bitte"], origin: ["ich komme aus", "ich wohne in"] },
    it: { greet: ["ciao", "buongiorno", "buonasera"], name: ["mi chiamo", "il mio nome è"], thanks: ["grazie"], bye: ["arrivederci"], well: ["sto bene", "molto bene", "bene"], please: ["per favore"], origin: ["sono di", "vivo a", "vivo in"] },
    pt: { greet: ["olá", "ola", "bom dia", "boa tarde", "boa noite"], name: ["chamo-me", "chamo me", "meu nome é", "o meu nome é"], thanks: ["obrigado", "obrigada"], bye: ["adeus", "tchau", "até logo", "ate logo"], well: ["estou bem", "muito bem", "bem"], please: ["por favor"], origin: ["sou de", "moro em", "moro no"] },
    en: { greet: ["hello", "hi", "good morning", "good evening"], name: ["my name is", "i'm", "i am"], thanks: ["thank you", "thanks"], bye: ["goodbye", "bye", "see you"], well: ["i'm fine", "i'm good", "very well", "fine"], please: ["please"], origin: ["i'm from", "i live in", "i come from"] },
    sw: { greet: ["habari", "jambo", "mambo", "shikamoo"], name: ["jina langu"], thanks: ["asante"], bye: ["kwaheri"], well: ["niko vizuri", "mzuri", "salam"], please: ["tafadhali"], origin: ["ninatoka", "natoka"] },
    yo: { greet: ["báwo ni", "bawo ni", "ẹ kú", "e kú", "pẹlẹ", "pẹ́lẹ́"], name: ["orúkọ mi", "oruko mi", "mo n je"], thanks: ["ẹ ṣe", "e se", "o ṣe", "o se"], bye: ["ọ dàbọ̀", "o dabo"], well: ["mo wà dáadáa", "mo wa daadaa", "dáadáa", "daadaa"], please: ["jọ̀wọ́", "jowo"], origin: ["mo wá láti", "mo wa lati", "mo n gbé", "mo n gbe"] },
    ig: { greet: ["ndewo", "kedu"], name: ["aha m", "a ha m"], thanks: ["daalụ", "daalu"], bye: ["ka ọ dị", "ka o di"], well: ["ọ dị m mma", "o di m mma", "di m mma"], please: ["biko"], origin: ["m si", "esi m", "m bi"] },
    ha: { greet: ["sannu", "barka da zuwa"], name: ["sunana", "sunan na"], thanks: ["na gode"], bye: ["sai anjima", "sai wata rana", "bai"], well: ["na lafiya", "lafiya lau", "lafiya"], please: ["don allah"], origin: ["na zo daga", "ina zaune"] },
    af: { greet: ["hallo", "goeie dag", "goeie more"], name: ["my naam is", "ek is"], thanks: ["dankie"], bye: ["totsiens"], well: ["ek is goed", "goed"], please: ["asseblief"], origin: ["ek kom uit", "ek woon in"] },
    zu: { greet: ["sawubona", "sanibonani"], name: ["igama lami"], thanks: ["ngiyabonga"], bye: ["hamba kahle", "sala kahle"], well: ["ngisaphila", "ngiyaphila"], please: ["ngiyacela"], origin: ["ngivela", "ngihlala"] },
    ar: { greet: ["مرحبا", "أهلا", "اهلا", "السلام عليكم"], name: ["اسمي"], thanks: ["شكرا"], bye: ["مع السلامة"], well: ["بخير", "أنا بخير"], please: ["من فضلك"], origin: ["أنا من"] },
    zh: { greet: ["你好", "您好", "大家好"], name: ["我叫", "我的名字是"], thanks: ["谢谢"], bye: ["再见", "拜拜"], well: ["我很好", "很好"], please: ["请"], origin: ["我来自", "我住在"] },
    ja: { greet: ["こんにちは", "はじめまして", "おはよう"], name: ["私は", "僕は", "名前は"], thanks: ["ありがとう"], bye: ["さようなら", "またね"], well: ["元気です", "おかげさまで"], please: ["お願いします"], origin: ["から来ました", "住んでいます"] },
    ko: { greet: ["안녕하세요", "안녕"], name: ["저는", "제 이름은"], thanks: ["감사합니다", "고맙습니다"], bye: ["안녕히 가세요", "안녕"], well: ["잘 지내요", "좋아요"], please: ["주세요", "부탁합니다"], origin: ["에서 왔어요", "살아요"] },
    ru: { greet: ["привет", "здравствуйте"], name: ["меня зовут", "мое имя", "моё имя"], thanks: ["спасибо"], bye: ["до свидания", "пока"], well: ["хорошо", "я в порядке", "нормально"], please: ["пожалуйста"], origin: ["я из", "живу в"] },
    hi: { greet: ["नमस्ते", "नमस्कार"], name: ["मेरा नाम", "मैं"], thanks: ["धन्यवाद"], bye: ["अलविदा", "फिर मिलेंगे"], well: ["ठीक हूँ", "मैं ठीक", "ठीक"], please: ["कृपया"], origin: ["से हूँ", "मैं रहता"] },
    tr: { greet: ["merhaba", "selam", "günaydın"], name: ["benim adım", "adım", "ben"], thanks: ["teşekkürler", "teşekkür ederim"], bye: ["hoşça kal", "görüşürüz"], well: ["iyiyim", "çok iyiyim"], please: ["lütfen"], origin: ["geliyorum", "yaşıyorum"] },
  }),

  DRINKS: Object.freeze({
    nl: ["koffie", "thee"],
    es: ["café", "cafe", "té", "te"],
    fr: ["café", "thé", "the"],
    de: ["kaffee", "tee"],
    it: ["caffè", "caffe", "tè", "te"],
    pt: ["café", "cafe", "chá", "cha"],
    en: ["coffee", "tea"],
    sw: ["kahawa", "chai"],
    af: ["koffie", "tee"],
  }),

  LESSON_FRAMES: Object.freeze({
    greetings: { goal: "Recognize and produce basic greetings", teach: "In {lang}, greetings depend on the time of day and formality. Study the examples below — each comes from this language's verified bank — then practice." },
    "numbers-basics": { goal: "Recognize numbers and everyday basics", teach: "Numbers are the backbone of shopping, times and prices. Study the examples, then practice." },
    "simple-sentences": { goal: "Build your first sentences", teach: "Simple sentences follow the language's basic word order with the verb matching the subject. The examples show correct forms." },
    "first-readings": { goal: "Read your first short texts", teach: "Short readings use the phrases you already know: names, cities, ages. Read carefully and answer." },
    "people-places": { goal: "Talk about people, family and places", teach: "People and places need everyday nouns plus the right articles. Study the examples, then practice." },
    "present-tense": { goal: "Describe everyday actions", teach: "Everyday actions use the present tense; verbs change with the person. The examples show the correct present-tense forms." },
    possession: { goal: "Say whose it is", teach: 'Possession is usually marked with a small function word (like "of" or an article change). The examples show the correct forms.' },
    "daily-life": { goal: "Read about daily life", teach: "Daily-life readings combine greetings, times and places. Read carefully and answer." },
    "past-tense": { goal: "Talk about the past", teach: "The past tense changes the verb form. The examples show correct past forms for common verbs." },
    conditionals: { goal: "Express conditions and wishes", teach: "Conditions use a special verb mood in the result or the if-clause. The examples show the correct forms." },
    opinions: { goal: "Share opinions and read longer texts", teach: "Opinions combine connectors with everyday vocabulary. Read carefully and answer." },
  }),

  writingTasks(lang) {
    const code = String(lang || "").trim().toLowerCase();
    const ph = this.PHRASES[code];
    if (!ph) return [];
    return [
      {
        code: "self-introduction",
        title: "Introduce yourself",
        instruction: "Write 1–3 sentences introducing yourself: greet the reader and say your name. (Bonus: say where you are from.)",
        required: [
          { element: "a greeting", patterns: ph.greet },
          { element: 'your name (e.g. a "my name is" phrase)', patterns: ph.name },
        ],
        bonus: [
          { element: "where you are from / live", patterns: ph.origin },
        ],
        checkedNote: "Structured feedback covers the required elements above (real pattern checks). Full free-form grammar correction needs the writing-correction provider (not configured) — it is never simulated.",
      },
      {
        code: "thank-you-note",
        title: "A short thank-you note",
        instruction: "Write a short thank-you note: thank the person and say goodbye.",
        required: [
          { element: "a thank-you phrase", patterns: ph.thanks },
          { element: "a goodbye phrase", patterns: ph.bye },
        ],
        bonus: [],
        checkedNote: "Checked elements: thanking + goodbye. Free-form style comments are not invented.",
      },
    ];
  },

  conversations(lang) {
    const code = String(lang || "").trim().toLowerCase();
    const ph = this.PHRASES[code];
    if (!ph) return [];
    const aiLine = ph.greet?.[0] || "";
    const scenarios = [
      {
        code: "first-meeting",
        title: "First meeting (A1)",
        mode: "beginner",
        aiOpeners: [aiLine, ""],
        turns: [
          { instruction: "Greet your new acquaintance.", element: "a greeting", patterns: ph.greet, example: ph.greet[0] || "" },
          { instruction: "Tell them your name.", element: 'a "my name is" phrase', patterns: ph.name, example: ph.name[0] || "" },
          { instruction: "Say how you are doing.", element: 'a "I am well" phrase', patterns: ph.well, example: ph.well[0] || "" },
          {
            instruction: "Thank them and say goodbye (use both a thank-you and a goodbye).",
            element: "thank-you AND goodbye",
            patterns: [...ph.thanks, ...ph.bye],
            requireAll: { thanks: ph.thanks, bye: ph.bye },
            example: `${ph.thanks[0] || ""} … ${ph.bye[0] || ""}`,
          },
        ],
      },
    ];
    if (this.DRINKS[code]) {
      const drinks = this.DRINKS[code];
      scenarios.push({
        code: "cafe",
        title: "At the café (A1)",
        mode: "restaurant",
        aiOpeners: [aiLine, ""],
        turns: [
          { instruction: "Greet the barista.", element: "a greeting", patterns: ph.greet, example: ph.greet[0] || "" },
          {
            instruction: "Order a coffee or a tea — politely (include a please-word).",
            element: "drink + polite word",
            patterns: [...drinks, ...ph.please],
            requireAll: { drink: drinks, please: ph.please },
            example: `${drinks[0]} + ${ph.please[0]}`,
          },
          { instruction: "Thank them.", element: "a thank-you phrase", patterns: ph.thanks, example: ph.thanks[0] || "" },
        ],
      });
    }
    return scenarios;
  },
};

const RAW_VOCABULARY_BANK = Object.freeze({
  nl: [
    ["hallo", "hello", null, "Hallo, ik heet Anna.", "greetings", "A1"],
    ["goedemorgen", "good morning", null, null, "greetings", "A1"],
    ["dank je wel", "thank you", null, null, "courtesy", "A1"],
    ["tot ziens", "goodbye", null, null, "courtesy", "A1"],
    ["ik", "I", null, null, "people", "A1"],
    ["vijf", "five", null, null, "numbers", "A1"],
    ["een", "one", null, null, "numbers", "A1"],
    ["het huis", "the house", null, null, "places", "A1"],
    ["de stad", "the city", null, null, "places", "A2"],
    ["de afspraak", "the appointment", null, null, "everyday", "A2"],
  ],
  es: [
    ["hola", "hello", null, null, "greetings", "A1"],
    ["buenos días", "good morning", null, null, "greetings", "A1"],
    ["gracias", "thank you", null, null, "courtesy", "A1"],
    ["adiós", "goodbye", null, null, "courtesy", "A1"],
    ["yo", "I", null, null, "people", "A1"],
    ["seis", "six", null, null, "numbers", "A1"],
    ["siete", "seven", null, null, "numbers", "A1"],
    ["ocho", "eight", null, null, "numbers", "A1"],
    ["el pueblo", "the town / village", null, null, "places", "A2"],
    ["la cita", "the appointment", null, null, "everyday", "A2"],
  ],
  fr: [
    ["bonjour", "hello / good day", null, null, "greetings", "A1"],
    ["merci", "thank you", null, null, "courtesy", "A1"],
    ["au revoir", "goodbye", null, null, "courtesy", "A1"],
    ["oui", "yes", null, null, "basics", "A1"],
    ["non", "no", null, null, "basics", "A1"],
    ["nous", "we", null, null, "people", "A1"],
    ["quatre", "four", null, null, "numbers", "A1"],
    ["deux", "two", null, null, "numbers", "A1"],
    ["la ville", "the city", null, null, "places", "A2"],
    ["un rendez-vous", "an appointment", null, null, "everyday", "A2"],
  ],
  de: [
    ["hallo", "hello", null, null, "greetings", "A1"],
    ["guten Morgen", "good morning", null, null, "greetings", "A1"],
    ["danke", "thank you", null, null, "courtesy", "A1"],
    ["tschüss", "bye", null, null, "courtesy", "A1"],
    ["ich", "I", null, null, "people", "A1"],
    ["ja", "yes", null, null, "basics", "A1"],
    ["nein", "no", null, null, "basics", "A1"],
    ["drei", "three", null, null, "numbers", "A1"],
    ["die Stadt", "the city", null, null, "places", "A2"],
    ["der Termin", "the appointment", null, null, "everyday", "A2"],
  ],
  it: [
    ["buongiorno", "good morning / hello", null, null, "greetings", "A1"],
    ["grazie", "thank you", null, null, "courtesy", "A1"],
    ["arrivederci", "goodbye", null, null, "courtesy", "A1"],
    ["io", "I", null, null, "people", "A1"],
    ["sì", "yes", null, null, "basics", "A1"],
    ["no", "no", null, null, "basics", "A1"],
    ["tre", "three", null, null, "numbers", "A1"],
    ["cinque", "five", null, null, "numbers", "A1"],
    ["la città", "the city", null, null, "places", "A2"],
    ["l'appuntamento", "the appointment", null, null, "everyday", "A2"],
  ],
  pt: [
    ["bom dia", "good morning", null, null, "greetings", "A1"],
    ["obrigado", "thank you (m. speaker)", null, null, "courtesy", "A1"],
    ["adeus", "goodbye", null, null, "courtesy", "A1"],
    ["eu", "I", null, null, "people", "A1"],
    ["sim", "yes", null, null, "basics", "A1"],
    ["não", "no", null, null, "basics", "A1"],
    ["dois", "two", null, null, "numbers", "A1"],
    ["seis", "six", null, null, "numbers", "A1"],
    ["a cidade", "the city", null, null, "places", "A2"],
    ["o compromisso", "the appointment", null, null, "everyday", "A2"],
  ],
  en: [
    ["hello", "hello", null, null, "greetings", "A1"],
    ["thank you", "thank you", null, null, "courtesy", "A1"],
    ["goodbye", "goodbye", null, null, "courtesy", "A1"],
    ["I", "I", null, null, "people", "A1"],
    ["yes", "yes", null, null, "basics", "A1"],
    ["no", "no", null, null, "basics", "A1"],
    ["three", "three", null, null, "numbers", "A1"],
    ["seven", "seven", null, null, "numbers", "A1"],
    ["the city", "the city", null, null, "places", "A1"],
    ["an appointment", "an appointment", null, null, "everyday", "A2"],
  ],
  sw: [
    ["habari", "hello (greeting)", null, null, "greetings", "A1"],
    ["asante", "thank you", null, null, "courtesy", "A1"],
    ["kwaheri", "goodbye", null, null, "courtesy", "A1"],
    ["karibu", "welcome", null, null, "courtesy", "A1"],
    ["moja", "one", null, null, "numbers", "A1"],
    ["mbili", "two", null, null, "numbers", "A1"],
    ["tatu", "three", null, null, "numbers", "A1"],
    ["jina", "name", null, "Jina langu ni Amina.", "people", "A1"],
    ["nyumba", "house", null, null, "places", "A1"],
    ["maji", "water", null, null, "food-drink", "A1"],
  ],
  yo: [
    ["báwo ni?", "how are you?", null, null, "greetings", "A1"],
    ["ẹ ṣe", "thank you", null, null, "courtesy", "A1"],
    ["ọ dàbọ̀", "goodbye", null, null, "courtesy", "A1"],
    ["ọ̀kan", "one", null, null, "numbers", "A1"],
    ["èjì", "two", null, null, "numbers", "A1"],
    ["ẹ̀ta", "three", null, null, "numbers", "A1"],
    ["ilé", "house / home", null, null, "places", "A1"],
    ["omí", "water", null, null, "food-drink", "A1"],
    ["owó", "money", null, null, "everyday", "A1"],
    ["ọjọ́", "day", null, null, "time", "A1"],
  ],
  ig: [
    ["ndewo", "hello", null, null, "greetings", "A1"],
    ["daalụ", "thank you", null, null, "courtesy", "A1"],
    ["ka ọ dị", "goodbye (for now)", null, null, "courtesy", "A1"],
    ["otu", "one", null, null, "numbers", "A1"],
    ["abụọ", "two", null, null, "numbers", "A1"],
    ["atọ", "three", null, null, "numbers", "A1"],
    ["ụlọ", "house", null, null, "places", "A1"],
    ["mmiri", "water", null, null, "food-drink", "A1"],
    ["ego", "money", null, null, "everyday", "A1"],
    ["ụbọchị", "day", null, null, "time", "A1"],
  ],
  ha: [
    ["sannu", "hello", null, null, "greetings", "A1"],
    ["na gode", "thank you", null, null, "courtesy", "A1"],
    ["sai anjima", "see you tomorrow (bye)", null, null, "courtesy", "A1"],
    ["daya", "one", null, null, "numbers", "A1"],
    ["biyu", "two", null, null, "numbers", "A1"],
    ["uku", "three", null, null, "numbers", "A1"],
    ["gida", "house / home", null, null, "places", "A1"],
    ["ruwa", "water", null, null, "food-drink", "A1"],
    ["kudi", "money", null, null, "everyday", "A1"],
    ["rana", "day / sun", null, null, "time", "A1"],
  ],
  af: [
    ["goeie dag", "good day / hello", null, null, "greetings", "A1"],
    ["dankie", "thank you", null, null, "courtesy", "A1"],
    ["totsiens", "goodbye", null, null, "courtesy", "A1"],
    ["asseblief", "please", null, null, "courtesy", "A1"],
    ["een", "one", null, null, "numbers", "A1"],
    ["twee", "two", null, null, "numbers", "A1"],
    ["drie", "three", null, null, "numbers", "A1"],
    ["huis", "house", null, null, "places", "A1"],
    ["water", "water", null, null, "food-drink", "A1"],
    ["stad", "city", null, "My naam is Pieter.", "places", "A1"],
  ],
  zu: [
    ["sawubona", "hello (one person)", null, null, "greetings", "A1"],
    ["ngiyabonga", "I thank you", null, null, "courtesy", "A1"],
    ["sala kahle", "goodbye (to one staying)", null, null, "courtesy", "A1"],
    ["kunye", "one", null, null, "numbers", "A1"],
    ["kubili", "two", null, null, "numbers", "A1"],
    ["kuthathu", "three", null, null, "numbers", "A1"],
    ["indlu", "house", null, null, "places", "A1"],
    ["amanzi", "water", null, null, "food-drink", "A1"],
    ["imali", "money", null, null, "everyday", "A1"],
    ["usuku", "day", null, null, "time", "A1"],
  ],
  ar: [
    ["مرحبا", "hello", "marhaban", null, "greetings", "A1"],
    ["شكرا", "thank you", "shukran", null, "courtesy", "A1"],
    ["مع السلامة", "goodbye", "ma'a as-salama", null, "courtesy", "A1"],
    ["اسمي", "my name", "ismī", "اسمي أحمد", "people", "A1"],
    ["واحد", "one", "wāḥid", null, "numbers", "A1"],
    ["اثنان", "two", "ithnān", null, "numbers", "A1"],
    ["ثلاثة", "three", "thalātha", null, "numbers", "A1"],
    ["بيت", "house", "bayt", null, "places", "A1"],
    ["ماء", "water", "mā'", null, "food-drink", "A1"],
    ["يوم", "day", "yawm", null, "time", "A1"],
  ],
  zh: [
    ["你好", "hello", "nǐ hǎo", null, "greetings", "A1"],
    ["谢谢", "thank you", "xièxie", null, "courtesy", "A1"],
    ["再见", "goodbye", "zàijiàn", null, "courtesy", "A1"],
    ["请", "please", "qǐng", null, "courtesy", "A1"],
    ["一", "one", "yī", null, "numbers", "A1"],
    ["二", "two", "èr", null, "numbers", "A1"],
    ["三", "three", "sān", null, "numbers", "A1"],
    ["家", "home / family", "jiā", null, "places", "A1"],
    ["水", "water", "shuǐ", null, "food-drink", "A1"],
    ["天", "day / sky", "tiān", null, "time", "A1"],
  ],
  ja: [
    ["こんにちは", "hello (daytime)", "konnichiwa", null, "greetings", "A1"],
    ["ありがとう", "thank you", "arigatō", null, "courtesy", "A1"],
    ["さようなら", "goodbye", "sayōnara", null, "courtesy", "A1"],
    ["はい", "yes", "hai", null, "basics", "A1"],
    ["いいえ", "no", "iie", null, "basics", "A1"],
    ["一", "one", "ichi", null, "numbers", "A1"],
    ["二", "two", "ni", null, "numbers", "A1"],
    ["三", "three", "san", null, "numbers", "A1"],
    ["家", "house / home", "ie", null, "places", "A1"],
    ["水", "water", "mizu", null, "food-drink", "A1"],
  ],
  ko: [
    ["안녕하세요", "hello", "annyeonghaseyo", null, "greetings", "A1"],
    ["감사합니다", "thank you", "gamsahamnida", null, "courtesy", "A1"],
    ["네", "yes", "ne", null, "basics", "A1"],
    ["아니요", "no", "aniyo", null, "basics", "A1"],
    ["하나", "one", "hana", null, "numbers", "A1"],
    ["둘", "two", "dul", null, "numbers", "A1"],
    ["셋", "three", "set", null, "numbers", "A1"],
    ["집", "house / home", "jip", null, "places", "A1"],
    ["물", "water", "mul", null, "food-drink", "A1"],
    ["날", "day", "nal", null, "time", "A1"],
  ],
  ru: [
    ["привет", "hi", "privet", null, "greetings", "A1"],
    ["спасибо", "thank you", "spasibo", null, "courtesy", "A1"],
    ["до свидания", "goodbye", "do svidaniya", null, "courtesy", "A1"],
    ["пожалуйста", "please / you are welcome", "pozhaluysta", null, "courtesy", "A1"],
    ["один", "one", "odin", null, "numbers", "A1"],
    ["два", "two", "dva", null, "numbers", "A1"],
    ["три", "three", "tri", null, "numbers", "A1"],
    ["дом", "house / home", "dom", null, "places", "A1"],
    ["вода", "water", "voda", null, "food-drink", "A1"],
    ["день", "day", "den'", null, "time", "A1"],
  ],
  hi: [
    ["नमस्ते", "hello / greetings", "namaste", null, "greetings", "A1"],
    ["धन्यवाद", "thank you", "dhanyavaad", null, "courtesy", "A1"],
    ["अलविदा", "goodbye", "alvida", null, "courtesy", "A1"],
    ["नाम", "name", "naam", "मेरा नाम राम है", "people", "A1"],
    ["एक", "one", "ek", null, "numbers", "A1"],
    ["दो", "two", "do", null, "numbers", "A1"],
    ["तीन", "three", "teen", null, "numbers", "A1"],
    ["घर", "house / home", "ghar", null, "places", "A1"],
    ["पानी", "water", "paani", null, "food-drink", "A1"],
    ["दिन", "day", "din", null, "time", "A1"],
  ],
  tr: [
    ["merhaba", "hello", null, null, "greetings", "A1"],
    ["teşekkürler", "thanks", null, null, "courtesy", "A1"],
    ["hoşça kal", "goodbye", null, null, "courtesy", "A1"],
    ["lütfen", "please", null, null, "courtesy", "A1"],
    ["bir", "one", null, null, "numbers", "A1"],
    ["iki", "two", null, null, "numbers", "A1"],
    ["üç", "three", null, null, "numbers", "A1"],
    ["ev", "house / home", null, null, "places", "A1"],
    ["su", "water", null, null, "food-drink", "A1"],
    ["gün", "day", null, null, "time", "A1"],
  ],
});

export const VocabularyBank = {
  items(lang) {
    const code = String(lang || "").trim().toLowerCase();
    return (RAW_VOCABULARY_BANK[code] || []).map((t) => ({
      word: t[0],
      translation: t[1],
      pronunciation: t[2],
      example: t[3],
      category: t[4],
      level: t[5],
    }));
  },

  count(lang) {
    const code = String(lang || "").trim().toLowerCase();
    return (RAW_VOCABULARY_BANK[code] || []).length;
  },
};

const TRANSLATOR_LOCALES = Object.freeze({
  nl: "nl-NL", es: "es-ES", it: "it-IT", fr: "fr-FR",
  de: "de-DE", en: "en-GB", pt: "pt-PT", ar: "ar-SA",
  zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", ru: "ru-RU",
  hi: "hi-IN", tr: "tr-TR", sw: "sw-KE", yo: "yo-NG",
  ig: "ig-NG", ha: "ha-NG", af: "af-ZA", zu: "zu-ZA",
});

const TRANSLATOR_PHRASES = Object.freeze({
  good_morning: {
    en: ["good morning", "good morning, how are you?", "good morning, how are you"],
    fr: ["bonjour, comment allez-vous ?", "bonjour, comment allez-vous", "bonjour"],
    es: ["buenos días, ¿cómo estás?", "buenos días, ¿cómo está usted?", "buenos días"],
    de: ["guten morgen, wie geht es dir?", "guten morgen, wie geht es ihnen?", "guten morgen"],
    it: ["buongiorno, come stai?", "buongiorno, come sta?", "buongiorno"],
    pt: ["bom dia, como está?", "bom dia, tudo bem?", "bom dia"],
    nl: ["goedemorgen, hoe gaat het?", "goedemorgen, hoe maakt u het?", "goedemorgen"],
    tr: ["günaydın, nasılsın?", "günaydın"],
    sw: ["habari za asubuhi, habari yako?", "habari za asubuhi"],
  },
  hello: {
    en: ["hello", "hi"],
    fr: ["bonjour", "salut"],
    es: ["hola"],
    de: ["hallo", "servus"],
    it: ["ciao", "salve"],
    pt: ["olá", "oi"],
    nl: ["hallo", "hoi"],
    tr: ["merhaba", "selam"],
    sw: ["habari", "hujambo"],
  },
  how_are_you: {
    en: ["how are you?", "how are you", "how are you doing?", "how are you doing"],
    fr: ["comment allez-vous ?", "comment allez-vous", "comment vas-tu ?", "comment vas-tu"],
    es: ["¿cómo estás?", "cómo estás", "¿cómo está usted?", "cómo está usted"],
    de: ["wie geht es dir?", "wie geht es ihnen?"],
    it: ["come stai?", "come sta?"],
    pt: ["como está?", "tudo bem?"],
    nl: ["hoe gaat het?", "hoe maakt u het?"],
    tr: ["nasılsın?", "nasılsınız?"],
    sw: ["habari yako?", "umetuje?"],
  },
  goodbye: {
    en: ["goodbye", "bye", "see you", "see you later"],
    fr: ["au revoir", "à bientôt"],
    es: ["adiós", "hasta luego", "chao"],
    de: ["auf wiedersehen", "tschüss", "bis bald"],
    it: ["arrivederci", "ciao", "a presto"],
    pt: ["adeus", "até logo", "tchau"],
    nl: ["tot ziens", "dag"],
    tr: ["hoşça kal", "güle güle"],
    sw: ["kwaheri", "tutaonana"],
  },
  thank_you: {
    en: ["thank you", "thanks", "thank you very much"],
    fr: ["merci", "merci beaucoup"],
    es: ["gracias", "muchas gracias"],
    de: ["danke", "vielen dank"],
    it: ["grazie", "grazie mille"],
    pt: ["obrigado", "obrigada", "muito obrigado"],
    nl: ["dank je", "dank u", "bedankt"],
    tr: ["teşekkür ederim", "teşekkürler"],
    sw: ["asante", "asante sana"],
  },
  please: {
    en: ["please"],
    fr: ["s'il vous plaît", "sil vous plaît", "s'il te plaît"],
    es: ["por favor"],
    de: ["bitte"],
    it: ["per favore", "per piacere"],
    pt: ["por favor"],
    nl: ["alstublieft", "alsjeblieft"],
    tr: ["lütfen"],
    sw: ["tafadhali"],
  },
  yes: {
    en: ["yes", "yeah"],
    fr: ["oui"],
    es: ["sí", "si"],
    de: ["ja"],
    it: ["sì", "si"],
    pt: ["sim"],
    nl: ["ja"],
    tr: ["evet"],
    sw: ["ndiyo", "naam"],
  },
  no: {
    en: ["no"],
    fr: ["non"],
    es: ["no"],
    de: ["nein"],
    it: ["no"],
    pt: ["não", "nao"],
    nl: ["nee"],
    tr: ["hayır", "hayir"],
    sw: ["hapana", "la"],
  },
  excuse_me: {
    en: ["excuse me", "sorry"],
    fr: ["excusez-moi", "excusez moi", "pardon"],
    es: ["disculpe", "perdón", "perdon"],
    de: ["entschuldigung", "entschuldigen sie"],
    it: ["mi scusi", "scusa"],
    pt: ["com licença", "desculpe"],
    nl: ["pardon", "neem me niet kwalijk"],
    tr: ["pardon", "afedersiniz"],
    sw: ["samahani", "pole"],
  },
  good_evening: {
    en: ["good evening"],
    fr: ["bonsoir"],
    es: ["buenas noches", "buenas tardes"],
    de: ["guten abend"],
    it: ["buonasera"],
    pt: ["boa noite", "boa tarde"],
    nl: ["goedenavond"],
    tr: ["iyi akşamlar", "iyi aksamlar"],
    sw: ["habari za jioni"],
  },
  what_is_your_name: {
    en: ["what is your name?", "what's your name?", "what is your name"],
    fr: ["comment vous appelez-vous ?", "comment vous appelez-vous", "comment tu t'appelles ?"],
    es: ["¿cómo te llamas?", "cómo te llamas", "¿cómo se llama usted?"],
    de: ["wie heißt du?", "wie heißen sie?", "wie heisst du?"],
    it: ["come ti chiami?", "come si chiama?"],
    pt: ["como você se chama?", "qual é o seu nome?"],
    nl: ["hoe heet je?", "hoe heet u?"],
    tr: ["adın ne?", "adınız ne?"],
    sw: ["jina lako nani?"],
  },
  my_name_is: {
    en: ["my name is", "i'm", "i am"],
    fr: ["je m'appelle", "je m appelle"],
    es: ["me llamo", "yo soy"],
    de: ["ich heiße", "ich heisse", "mein name ist"],
    it: ["mi chiamo"],
    pt: ["eu me chamo", "meu nome é", "meu nome e"],
    nl: ["ik heet", "mijn naam is"],
    tr: ["benim adım", "benim adim", "adım", "adim"],
    sw: ["jina langu ni"],
  },
  nice_to_meet_you: {
    en: ["nice to meet you", "pleased to meet you"],
    fr: ["enchanté", "enchantée", "ravi de vous rencontrer"],
    es: ["encantado", "encantada", "mucho gusto"],
    de: ["schön, dich kennenzulernen", "freut mich"],
    it: ["piacere", "piacere di conoscerti"],
    pt: ["prazer", "muito prazer"],
    nl: ["aangenaam", "leuk je te ontmoeten"],
    tr: ["tanıştığımıza memnun oldum", "tanistigimiza memnun oldum", "memnun oldum"],
    sw: ["ninafurahi kukutana na wewe"],
  },
  i_do_not_understand: {
    en: ["i don't understand", "i do not understand"],
    fr: ["je ne comprends pas"],
    es: ["no entiendo", "no comprendo"],
    de: ["ich verstehe nicht"],
    it: ["non capisco", "non comprendo"],
    pt: ["não entendo", "nao entendo", "não compreendo"],
    nl: ["ik begrijp het niet"],
    tr: ["anlamıyorum", "anlamiyorum"],
    sw: ["sielewi"],
  },
  do_you_speak_english: {
    en: ["do you speak english?"],
    fr: ["parlez-vous anglais ?", "parlez-vous anglais", "est-ce que vous parlez anglais ?"],
    es: ["¿hablas inglés?", "hablas inglés", "¿habla inglés?"],
    de: ["sprichst du englisch?", "sprechen sie englisch?"],
    it: ["parli inglese?", "parla inglese?"],
    pt: ["você fala inglês?", "voce fala ingles?"],
    nl: ["spreek je engels?", "spreekt u engels?"],
    tr: ["ingilizce konuşuyor musun?", "ingilizce konusuyor musun?"],
    sw: ["unaongea kiingereza?"],
  },
  where_is_the: {
    en: ["where is", "where's", "how do i get to"],
    fr: ["où est", "ou est", "où se trouve", "ou se trouve"],
    es: ["¿dónde está", "dónde está", "¿dónde está el", "dónde está el"],
    de: ["wo ist", "wo ist der", "wo ist die"],
    it: ["dov'è", "dove è", "dov'è il", "dove si trova"],
    pt: ["onde é", "onde fica", "onde está"],
    nl: ["waar is", "waar is de", "waar is het"],
    tr: ["nerede", "nerede ..."],
    sw: ["wapi ...", "iko wapi"],
  },
  how_much: {
    en: ["how much is it?", "how much", "how much does it cost?"],
    fr: ["combien ça coûte ?", "combien ca coute", "combien ?", "combien"],
    es: ["¿cuánto cuesta?", "cuánto cuesta", "¿cuánto es?", "cuánto es"],
    de: ["wie viel kostet das?", "wieviel kostet das?", "wie viel"],
    it: ["quanto costa?", "quanto"],
    pt: ["quanto custa?", "quanto é?", "quanto e?"],
    nl: ["hoeveel kost het?", "hoeveel"],
    tr: ["ne kadar?", "bu ne kadar?"],
    sw: ["ni bei gani?", "ni bei ngapi?"],
  },
  i_would_like: {
    en: ["i would like", "i'd like", "i want", "can i have"],
    fr: ["je voudrais", "j'aimerais", "j aimerais"],
    es: ["me gustaría", "me gustaria", "quiero"],
    de: ["ich möchte", "ich hätte gern", "ich mochte"],
    it: ["vorrei", "mi piacerebbe"],
    pt: ["eu gostaria", "eu quero"],
    nl: ["ik wil graag", "ik zou willen"],
    tr: ["istiyorum", "bir ... alabilir miyim"],
    sw: ["ningependa", "nataka"],
  },
  the_bill: {
    en: ["the bill, please", "check, please", "can i have the bill"],
    fr: ["l'addition, s'il vous plaît", "l'addition s'il vous plaît", "l'addition"],
    es: ["la cuenta, por favor", "la cuenta por favor"],
    de: ["die rechnung, bitte", "die rechnung bitte"],
    it: ["il conto, per favore", "il conto per favore"],
    pt: ["a conta, por favor", "a conta por favor"],
    nl: ["de rekening, alstublieft", "de rekening alstublieft"],
    tr: ["hesabı lütfen", "hesabi lutfen"],
    sw: ["bili, tafadhali"],
  },
  i_love_you: {
    en: ["i love you"],
    fr: ["je t'aime", "je t aime"],
    es: ["te quiero", "te amo"],
    de: ["ich liebe dich"],
    it: ["ti amo", "ti voglio bene"],
    pt: ["eu te amo", "amo-te"],
    nl: ["ik hou van jou", "ik hou van je"],
    tr: ["seni seviyorum"],
    sw: ["nakupenda"],
  },
  see_you_tomorrow: {
    en: ["see you tomorrow"],
    fr: ["à demain", "a demain"],
    es: ["hasta mañana", "hasta manana"],
    de: ["bis morgen"],
    it: ["a domani"],
    pt: ["até amanhã", "ate amanha"],
    nl: ["tot morgen"],
    tr: ["yarın görüşürüz", "yarin gorusuruz"],
    sw: ["tuonane kesho"],
  },
  good_night: {
    en: ["good night"],
    fr: ["bonne nuit"],
    es: ["buenas noches"],
    de: ["gute nacht"],
    it: ["buonanotte"],
    pt: ["boa noite"],
    nl: ["goedenacht", "welterusten"],
    tr: ["iyi geceler"],
    sw: ["lala salama"],
  },
});

const TRANSLATOR_WORDS = Object.freeze({
  good: { fr: "bon", es: "bueno", de: "gut", it: "buono", pt: "bom", nl: "goed", tr: "iyi", sw: "nzuri" },
  morning: { fr: "matin", es: "mañana", de: "morgen", it: "mattina", pt: "manhã", nl: "ochtend", tr: "sabah", sw: "asubuhi" },
  evening: { fr: "soir", es: "tarde", de: "abend", it: "sera", pt: "noite", nl: "avond", tr: "akşam", sw: "jioni" },
  night: { fr: "nuit", es: "noche", de: "nacht", it: "notte", pt: "noite", nl: "nacht", tr: "gece", sw: "usiku" },
  how: { fr: "comment", es: "cómo", de: "wie", it: "come", pt: "como", nl: "hoe", tr: "nasıl", sw: "vipi" },
  are: { fr: "allez/êtes", es: "estás", de: "bist/sind", it: "stai", pt: "está", nl: "gaat/bent", tr: "—", sw: "—" },
  you: { fr: "vous", es: "tú/usted", de: "du/sie", it: "tu/lei", pt: "você", nl: "je/u", tr: "sen/siz", sw: "wewe" },
  the: { fr: "le/la", es: "el/la", de: "der/die", it: "il/la", pt: "o/a", nl: "de/het", tr: "—", sw: "—" },
  water: { fr: "l'eau", es: "agua", de: "wasser", it: "acqua", pt: "água", nl: "water", tr: "su", sw: "maji" },
  food: { fr: "nourriture", es: "comida", de: "essen", it: "cibo", pt: "comida", nl: "eten", tr: "yemek", sw: "chakula" },
  coffee: { fr: "café", es: "café", de: "kaffee", it: "caffè", pt: "café", nl: "koffie", tr: "kahve", sw: "kahawa" },
  tea: { fr: "thé", es: "té", de: "tee", it: "tè", pt: "chá", nl: "thee", tr: "çay", sw: "chai" },
  friend: { fr: "ami", es: "amigo", de: "freund", it: "amico", pt: "amigo", nl: "vriend", tr: "arkadaş", sw: "rafiki" },
  house: { fr: "maison", es: "casa", de: "haus", it: "casa", pt: "casa", nl: "huis", tr: "ev", sw: "nyumba" },
  school: { fr: "école", es: "escuela", de: "schule", it: "scuola", pt: "escola", nl: "school", tr: "okul", sw: "shule" },
  book: { fr: "livre", es: "libro", de: "buch", it: "libro", pt: "livro", nl: "boek", tr: "kitap", sw: "kitabu" },
  one: { fr: "un", es: "uno", de: "eins", it: "uno", pt: "um", nl: "één", tr: "bir", sw: "moja" },
  two: { fr: "deux", es: "dos", de: "zwei", it: "due", pt: "dois", nl: "twee", tr: "iki", sw: "mbili" },
  three: { fr: "trois", es: "tres", de: "drei", it: "tre", pt: "três", nl: "drie", tr: "üç", sw: "tatu" },
  yes: { fr: "oui", es: "sí", de: "ja", it: "sì", pt: "sim", nl: "ja", tr: "evet", sw: "ndiyo" },
  no: { fr: "non", es: "no", de: "nein", it: "no", pt: "não", nl: "nee", tr: "hayır", sw: "hapana" },
  big: { fr: "grand", es: "grande", de: "groß", it: "grande", pt: "grande", nl: "groot", tr: "büyük", sw: "kubwa" },
  small: { fr: "petit", es: "pequeño", de: "klein", it: "piccolo", pt: "pequeno", nl: "klein", tr: "küçük", sw: "dogo" },
  today: { fr: "aujourd'hui", es: "hoy", de: "heute", it: "oggi", pt: "hoje", nl: "vandaag", tr: "bugün", sw: "leo" },
  tomorrow: { fr: "demain", es: "mañana", de: "morgen", it: "domani", pt: "amanhã", nl: "morgen", tr: "yarın", sw: "kesho" },
  love: { fr: "amour", es: "amor", de: "liebe", it: "amore", pt: "amor", nl: "liefde", tr: "aşk", sw: "upendo" },
  time: { fr: "temps", es: "tiempo", de: "zeit", it: "tempo", pt: "tempo", nl: "tijd", tr: "zaman", sw: "wakati" },
  day: { fr: "jour", es: "día", de: "tag", it: "giorno", pt: "dia", nl: "dag", tr: "gün", sw: "siku" },
  yes_please: { fr: "oui", es: "sí", de: "ja bitte", it: "sì", pt: "sim", nl: "ja", tr: "evet", sw: "ndiyo" },
});

function normText(text) {
  return String(text || "").toLowerCase().replace(/\s+/gu, " ").trim();
}

let phraseIndexCache = null;
let wordIndexCache = null;

function ensurePhraseIndex() {
  if (phraseIndexCache) return phraseIndexCache;
  const idx = new Map();
  for (const [concept, byLang] of Object.entries(TRANSLATOR_PHRASES)) {
    for (const [lang, variants] of Object.entries(byLang)) {
      for (const vRaw of variants) {
        const v = normText(vRaw);
        if (!v) continue;
        if (!idx.has(v)) idx.set(v, []);
        idx.get(v).push({ concept, lang });
      }
    }
  }
  const sortedEntries = [...idx.entries()].sort((a, b) => [...b[0]].length - [...a[0]].length);
  phraseIndexCache = new Map(sortedEntries);
  return phraseIndexCache;
}

function ensureWordIndex() {
  if (wordIndexCache) return wordIndexCache;
  const idx = new Map();
  for (const [en, byLang] of Object.entries(TRANSLATOR_WORDS)) {
    if (!idx.has(en)) idx.set(en, []);
    idx.get(en).push({ word: en, lang: "en" });
    for (const [lang, wordRaw] of Object.entries(byLang)) {
      if (wordRaw === "—" || !wordRaw) continue;
      for (const wPart of String(wordRaw).split("/")) {
        const w = normText(wPart);
        if (!w) continue;
        if (!idx.has(w)) idx.set(w, []);
        idx.get(w).push({ word: en, lang });
      }
    }
  }
  wordIndexCache = idx;
  return wordIndexCache;
}

function detectByScript(text) {
  if (/[\u0600-\u06FF]/u.test(text)) return "ar";
  if (/[\u4E00-\u9FFF]/u.test(text)) return "zh";
  if (/[\u3040-\u30FF]/u.test(text)) return "ja";
  if (/[\uAC00-\uD7AF]/u.test(text)) return "ko";
  if (/[\u0400-\u04FF]/u.test(text)) return "ru";
  if (/[\u0900-\u097F]/u.test(text)) return "hi";
  return null;
}

export const Translator = {
  LOCALES: TRANSLATOR_LOCALES,

  localeFor(code) {
    const key = String(code || "").trim().toLowerCase();
    return TRANSLATOR_LOCALES[key] || key;
  },

  languages() {
    return LanguageRegistry.all();
  },

  languageName(code) {
    const key = String(code || "").trim().toLowerCase();
    const lang = LanguageRegistry.get(key);
    return lang?.name || key.toUpperCase();
  },

  detect(text) {
    const normalized = normText(text);
    if (!normalized) {
      return { code: null, name: null, method: null, confidence: 0.0 };
    }
    const phraseIdx = ensurePhraseIndex();
    for (const [variant, matches] of phraseIdx.entries()) {
      if (normalized === variant || normalized.startsWith(variant)) {
        const hit = matches[0];
        return { code: hit.lang, name: this.languageName(hit.lang), method: "phrase", confidence: 0.95 };
      }
    }

    const wordIdx = ensureWordIndex();
    const tokens = normalized.replace(/[^\p{L}\p{N}\s']+/gu, " ").split(/\s+/u).filter(Boolean);
    if (tokens.length > 0) {
      const counts = {};
      let matched = 0;
      for (const tok of tokens) {
        const entries = wordIdx.get(tok);
        if (!entries) continue;
        matched += 1;
        for (const entry of entries) {
          counts[entry.lang] = (counts[entry.lang] || 0) + 1;
        }
      }
      const sortedLangs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sortedLangs.length > 0) {
        const [top, topCount] = sortedLangs[0];
        const confidence = Math.round((topCount / tokens.length) * 100) / 100;
        if (confidence >= 0.5) {
          return { code: top, name: this.languageName(top), method: "dictionary", confidence };
        }
      }
    }

    const script = detectByScript(normalized);
    if (script) {
      return { code: script, name: this.languageName(script), method: "script", confidence: 0.7 };
    }

    return { code: null, name: null, method: null, confidence: 0.0 };
  },

  translate(text, target, source = null) {
    const cleanTarget = String(target || "").trim().toLowerCase();
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      throw new Error("text must not be empty");
    }
    if (!LanguageRegistry.get(cleanTarget)) {
      throw new Error(`unsupported target language: ${cleanTarget}`);
    }

    const detected = this.detect(cleanText);
    const resolvedSource = source !== null && source !== undefined && String(source).trim() !== ""
      ? String(source).trim().toLowerCase()
      : (detected.code || "en");
    const sourceName = this.languageName(resolvedSource);
    const targetName = this.languageName(cleanTarget);

    const base = {
      source: resolvedSource,
      sourceName,
      target: cleanTarget,
      targetName,
      targetLocale: this.localeFor(cleanTarget),
      detected,
      translation: null,
      method: null,
      note: null,
      romanization: null,
    };

    if (resolvedSource === cleanTarget) {
      base.translation = cleanText;
      base.method = "same-language";
      base.note = "Source and target are the same language — the text is shown unchanged.";
      return base;
    }

    const seg = this._segment(cleanText, resolvedSource, cleanTarget);
    if (seg && seg.covered) {
      base.translation = seg.text;
      base.method = seg.method;
      base.note = seg.method === "phrasebook"
        ? "Translated from the authored phrasebook."
        : seg.method === "word-by-word"
          ? `Approximation: each word was looked up in the dictionary and joined in order. Word order and grammar may not be natural in ${targetName}.`
          : "Translated from the phrasebook where phrases matched, with a word-by-word pass for the rest.";
      return base;
    }

    base.translation = null;
    base.method = "none";
    base.note = "This sentence is not in the authored phrasebook or dictionary yet, so no fluent translation is available. Try a shorter sentence, a common greeting, or single words.";
    return base;
  },

  _segment(text, source, target) {
    const phraseIdx = ensurePhraseIndex();
    const wordIdx = ensureWordIndex();
    const norm = normText(text);
    if (!norm) return null;

    const sourcePhrases = [];
    for (const [variant, matches] of phraseIdx.entries()) {
      for (const m of matches) {
        if (m.lang === source) {
          sourcePhrases.push([variant, m.concept]);
          break;
        }
      }
    }
    sourcePhrases.sort((a, b) => [...b[0]].length - [...a[0]].length);

    const pieces = [];
    let best = 0;
    let covered = 0;
    let cursor = 0;

    while (cursor < norm.length) {
      while (cursor < norm.length && norm[cursor] === " ") cursor += 1;
      if (cursor >= norm.length) break;

      let matchedPhrase = false;
      for (const [variant, concept] of sourcePhrases) {
        if (!norm.startsWith(variant, cursor)) continue;
        const after = norm[cursor + variant.length] || "";
        if (after !== "" && !" ,.!?;".includes(after)) continue;
        const variants = TRANSLATOR_PHRASES[concept]?.[target];
        if (variants && variants.length > 0) {
          const picked = [...variants].sort(
            (a, b) => Math.abs([...a].length - [...variant].length) - Math.abs([...b].length - [...variant].length),
          )[0];
          pieces.push(picked);
          cursor += variant.length;
          best = Math.max(best, 2);
          covered += 1;
          matchedPhrase = true;
          break;
        }
      }
      if (matchedPhrase) continue;

      const nextSpace = norm.indexOf(" ", cursor);
      const tok = (nextSpace === -1 ? norm.slice(cursor) : norm.slice(cursor, nextSpace)).trim();
      if (!tok) {
        cursor += 1;
        continue;
      }
      let enPivot = null;
      const entries = wordIdx.get(tok);
      if (entries) {
        for (const e of entries) {
          if (e.lang === source) {
            enPivot = e.word;
            break;
          }
        }
      }
      if (enPivot && TRANSLATOR_WORDS[enPivot]?.[target] && TRANSLATOR_WORDS[enPivot][target] !== "—") {
        pieces.push(TRANSLATOR_WORDS[enPivot][target]);
        best = Math.max(best, 1);
        covered += 1;
      } else {
        pieces.push(tok);
      }
      cursor += tok.length;
    }

    if (covered === 0) return null;
    return {
      text: pieces.join(" "),
      method: best === 1 ? "word-by-word" : "phrasebook",
      covered: covered > 0,
    };
  },
};

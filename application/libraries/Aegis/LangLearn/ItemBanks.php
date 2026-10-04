<?php
namespace Aegis\LangLearn;

/**
 * ASSESSMENT ITEM BANKS — real, authored, CEFR-tagged questions.
 *
 * Honesty contract: every question below is genuine content. Bank size and
 * the highest level actually covered per language are reported as-is; a
 * level can never be awarded above the bank's ceiling, and languages without
 * items report "assessment not yet available" instead of guessing.
 *
 * Item tuple: [skill, level, prompt, [options], answerIndex, explanation]
 * Answer indexes are varied on purpose; grading always happens server-side.
 */
final class ItemBanks
{
    private const BANKS = [
        'nl' => [ // Dutch
            ['vocabulary', 'A1', "What does 'Goedemorgen' mean?", ['Good evening', 'Good morning', 'Good night', 'Goodbye'], 1, 'goede = good, morgen = morning.'],
            ['vocabulary', 'A1', "What does 'Dank je wel' mean?", ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'The common informal thank-you.'],
            ['vocabulary', 'A1', "Which number is 'vijf'?", ['4', '5', '15', '50'], 1, 'een, twee, drie, vier, vijf (1-5).'],
            ['vocabulary', 'A2', "What does 'de afspraak' mean?", ['A bicycle', 'An appointment', 'Homework', 'Breakfast'], 1, 'Een afspraak maken = to make an appointment.'],
            ['vocabulary', 'A2', "What does 'de stad' mean?", ['The street', 'The shop', 'The city', 'The station'], 2, 'de stad = city; het dorp = village.'],
            ['grammar', 'A1', 'Ik ___ een boek. (hebben)', ['heeft', 'heb', 'hebben', 'bent'], 1, 'With ik (I) use heb.'],
            ['grammar', 'A1', '___ je uit Nederland? (komen)', ['Komt', 'Kommen', 'Kom', 'Komes'], 2, 'In questions with je the verb drops the -t: Kom je...?'],
            ['grammar', 'A2', '___ huis is groot. (article)', ['De', 'Een', 'Der', 'Het'], 3, 'Huis is a het-word: het huis. Learn the article with every noun.'],
            ['grammar', 'A2', 'Gisteren ___ ik naar school. (gaan, verleden tijd)', ['ga', 'ging', 'gaande', 'gaat'], 1, 'Past tense of gaan (ik) is ging.'],
            ['grammar', 'B1', 'Als ik rijk ___, zou ik de wereld rondreizen.', ['was', 'ben', 'waren', 'is'], 0, 'Hypothetical condition: Als ik rijk was... (past tense in the if-clause).'],
            ['reading', 'A1', "Anna zegt: 'Hallo, ik heet Anna. Ik woon in Utrecht.' Where does Anna live?", ['Amsterdam', 'Utrecht', 'Anna', 'At school'], 1, 'Ik woon in Utrecht = I live in Utrecht.'],
            ['reading', 'A2', "Tom zegt: 'Ik heb geen tijd vandaag, maar morgen kan ik.' When can Tom?", ['Today', 'Never', 'Tomorrow', 'Tonight'], 2, 'morgen kan ik = tomorrow I can.'],
        ],
        'es' => [ // Spanish
            ['vocabulary', 'A1', "¿Qué significa 'Buenos días'?", ['Good night', 'Good morning', 'See you later', 'Please'], 1, 'Used until early afternoon.'],
            ['vocabulary', 'A1', "¿Qué significa 'Gracias'?", ['Hello', 'Sorry', 'Thank you', 'Goodbye'], 2, 'muchas gracias = thank you very much.'],
            ['vocabulary', 'A1', "¿Cuál número es 'siete'?", ['6', '7', '8', '70'], 1, 'seis, siete, ocho.'],
            ['vocabulary', 'A2', "¿Qué significa 'la cita'?", ['An appointment', 'A mountain', 'A spoon', 'A song'], 0, 'tener una cita = to have an appointment.'],
            ['vocabulary', 'A2', "¿Qué significa 'el pueblo'?", ['The country', 'The town/village', 'The beach', 'The people only'], 1, 'el pueblo = town or village (also the people in another sense).'],
            ['grammar', 'A1', 'Yo ___ estudiante.', ['eres', 'es', 'soy', 'son'], 2, 'Ser with yo is soy.'],
            ['grammar', 'A1', 'Ella ___ en Madrid. (vivir)', ['vive', 'vivo', 'vives', 'vivir'], 0, 'Third person singular: vive.'],
            ['grammar', 'A2', 'Ayer nosotros ___ al cine. (ir, pasado)', ['vamos', 'fuimos', 'iremos', 'vamos a'], 1, 'Preterite of ir (nosotros): fuimos.'],
            ['grammar', 'A2', 'Es el libro ___ María.', ['por', 'para', 'de', 'del'], 2, 'Possession with de: el libro de María.'],
            ['grammar', 'B1', 'Espero que tú ___ mañana. (venir)', ['vienes', 'vengas', 'vendrás', 'viniste'], 1, 'Esperar que + present subjunctive: vengas.'],
            ['reading', 'A1', "María dice: 'Me llamo María y tengo veinte años.' How old is María?", ['12', '20', '30', '2'], 1, 'veinte años = 20 years old.'],
            ['reading', 'A2', 'El tren sale a las ocho y llega a las nueve. How long is the journey?', ['8 hours', '9 hours', '1 hour', '30 minutes'], 2, 'From 8:00 to 9:00 is one hour.'],
        ],
        'fr' => [ // French
            ['vocabulary', 'A1', "'Bonjour' signifie…", ['Good night', 'Hello / good day', 'Goodbye', 'Please'], 1, 'Standard daytime greeting.'],
            ['vocabulary', 'A1', "'Merci' signifie…", ['Sorry', 'Hello', 'Thank you', 'Excuse me'], 2, 'merci beaucoup = thank you very much.'],
            ['vocabulary', 'A1', "Quel nombre est 'quatre' ?", ['2', '4', '6', '40'], 1, 'un, deux, trois, quatre.'],
            ['vocabulary', 'A2', "'un rendez-vous' signifie…", ['A car', 'A meal', 'A book', 'An appointment'], 3, 'prendre un rendez-vous = to make an appointment.'],
            ['vocabulary', 'A2', "'la ville' signifie…", ['The village', 'The street', 'The city', 'The shop'], 2, 'la ville = city; le village = village.'],
            ['grammar', 'A1', 'Je ___ français. (parler)', ['parles', 'parle', 'parlent', 'parler'], 1, 'With je, drop -er: je parle.'],
            ['grammar', 'A1', 'Nous ___ étudiants. (être)', ['sommes', 'êtes', 'suis', 'sont'], 0, 'nous sommes = we are.'],
            ['grammar', 'A2', 'Hier, je ___ au cinéma. (aller, passé composé)', ['vais', 'suis allé', 'vais allé', 'allant'], 1, 'Aller takes être in the passé composé: je suis allé(e).'],
            ['grammar', 'A2', "C'est le livre ___ Marie.", ['du', 'la', 'de', 'pour'], 2, 'Possession: le livre de Marie.'],
            ['grammar', 'B1', 'Il faut que je ___ à la banque. (aller)', ['vais', 'aille', 'irai', 'allais'], 1, 'Il faut que + subjunctive: aille.'],
            ['reading', 'A1', "Paul dit : « Je m'appelle Paul. J'habite à Lyon. » Where does Paul live?", ['Paris', 'Lyon', 'Nice', 'At school'], 1, "J'habite à Lyon = I live in Lyon."],
            ['reading', 'A2', 'Le magasin est fermé le dimanche.', ['Every day', 'At night', 'On Mondays', 'On Sundays'], 3, 'le dimanche = on Sundays.'],
        ],
        'de' => [ // German
            ['vocabulary', 'A1', "'Guten Morgen' bedeutet…", ['Good evening', 'Good night', 'Good morning', 'Bye'], 2, 'Morning greeting.'],
            ['vocabulary', 'A1', "'Danke' bedeutet…", ['Please', 'Sorry', 'Hello', 'Thank you'], 3, 'danke schön = thank you kindly.'],
            ['vocabulary', 'A1', "Welche Zahl ist 'drei'?", ['2', '3', '4', '13'], 1, 'eins, zwei, drei.'],
            ['vocabulary', 'A2', "'der Termin' bedeutet…", ['A trip', 'A dish', 'An appointment', 'A television'], 2, 'einen Termin machen = to make an appointment.'],
            ['vocabulary', 'A2', "'die Stadt' bedeutet…", ['The shop', 'The city', 'The street', 'The station'], 1, 'die Stadt = city; das Dorf = village.'],
            ['grammar', 'A1', 'Ich ___ Student.', ['bist', 'ist', 'bin', 'sind'], 2, 'sein: ich bin.'],
            ['grammar', 'A1', 'Du ___ aus Berlin? (kommen)', ['komme', 'kommen', 'kommt', 'kommst'], 3, 'du kommst.'],
            ['grammar', 'A2', 'Gestern ___ ich ins Kino. (gehen, Präteritum)', ['ging', 'gehe', 'gehst', 'gehend'], 0, 'Präteritum of gehen (ich): ging.'],
            ['grammar', 'A2', 'Ich fahre mit ___ Bus.', ['den', 'dem', 'der', 'das'], 1, 'mit + Dativ; der Bus becomes dem Bus.'],
            ['grammar', 'B1', 'Wenn ich mehr Zeit ___, würde ich mehr lesen.', ['hätte', 'habe', 'hatte', 'haben'], 0, 'Konjunktiv II in the conditional clause: hätte.'],
            ['reading', 'A1', 'Lisa sagt: „Ich heiße Lisa und wohne in Bonn." Where does Lisa live?', ['Berlin', 'Wien', 'Bonn', 'At school'], 2, 'wohne in Bonn = live in Bonn.'],
            ['reading', 'A2', 'Der Zug fährt um acht Uhr ab.', ['At 6:00', 'At 8:00', 'In 8 days', 'Tonight'], 1, 'um acht Uhr = at 8 oclock.'],
        ],
        'it' => [ // Italian
            ['vocabulary', 'A1', "'Buongiorno' significa…", ['Good night', 'Hello and bye', 'Good morning', 'Please'], 2, 'Daytime greeting.'],
            ['vocabulary', 'A1', "'Grazie' significa…", ['Sorry', 'Hello', 'Goodbye', 'Thank you'], 3, 'grazie mille = thanks a lot.'],
            ['vocabulary', 'A1', "Quale numero è 'cinque'?", ['4', '5', '6', '50'], 1, 'uno, due, tre, quattro, cinque.'],
            ['vocabulary', 'A2', "'l'appuntamento' significa…", ['The apartment', 'The appointment', 'The dish', 'The ticket'], 1, 'fissare un appuntamento = to arrange an appointment.'],
            ['vocabulary', 'A2', "'la città' significa…", ['The village', 'The street', 'The city', 'The shop'], 2, 'la città = city; il paese = village or country.'],
            ['grammar', 'A1', 'Io ___ italiano. (parlare)', ['parli', 'parla', 'parlo', 'parlare'], 2, 'io parlo.'],
            ['grammar', 'A1', 'Lei ___ a Roma. (vivere)', ['vive', 'vivo', 'vivi', 'vivere'], 0, 'lei vive.'],
            ['grammar', 'A2', 'Ieri ___ al cinema. (andare, passato)', ['vado', 'andai', 'andrò', 'andando'], 1, 'Passato remoto of andare (io): andai.'],
            ['grammar', 'A2', 'È il libro ___ Maria.', ['del', 'dalla', 'di', 'per'], 2, 'Possession with di: il libro di Maria.'],
            ['grammar', 'B1', 'Se avessi tempo, ___ venire. (potere)', ['posso', 'potrei', 'potevo', 'potrò'], 1, 'Conditional after se + past subjunctive: potrei.'],
            ['reading', 'A1', 'Marco dice: «Mi chiamo Marco e abito a Torino.» Where does Marco live?', ['Roma', 'Torino', 'Milano', 'At school'], 1, 'abito a Torino = I live in Turin.'],
            ['reading', 'A2', 'Il negozio è chiuso la domenica.', ['On Saturdays', 'Every day', 'In the morning', 'On Sundays'], 3, 'la domenica = on Sundays.'],
        ],
        'pt' => [ // Portuguese
            ['vocabulary', 'A1', "'Bom dia' significa…", ['Good night', 'Goodbye', 'Good morning', 'Please'], 2, 'Morning greeting.'],
            ['vocabulary', 'A1', "'Obrigado' significa…", ['Sorry', 'Hello', "You're welcome", 'Thank you (said by a man)'], 3, 'A woman says obrigada — the ending agrees with the speaker.'],
            ['vocabulary', 'A1', "Qual número é 'seis'?", ['5', '6', '7', '60'], 1, 'cinco, seis, sete.'],
            ['vocabulary', 'A2', "'o compromisso' significa…", ['A computer', 'Bread', 'An appointment', 'Advice'], 2, 'marcar um compromisso = to schedule an appointment.'],
            ['vocabulary', 'A2', "'a cidade' significa…", ['The village', 'The city', 'The beach', 'The shop'], 1, 'a cidade = city; a aldeia = village.'],
            ['grammar', 'A1', 'Eu ___ português. (falar)', ['falas', 'fala', 'falo', 'falar'], 2, 'eu falo.'],
            ['grammar', 'A1', 'Ela ___ em Lisboa. (morar)', ['mora', 'moro', 'moras', 'morar'], 0, 'ela mora.'],
            ['grammar', 'A2', 'Ontem nós ___ ao cinema. (ir, pretérito)', ['vamos', 'fomos', 'íamos', 'iremos'], 1, 'Pretérito perfeito of ir (nós): fomos.'],
            ['grammar', 'A2', 'É o livro ___ Maria.', ['do', 'da', 'para', 'de'], 3, 'Possession with de: o livro de Maria.'],
            ['grammar', 'B1', 'Se eu tivesse dinheiro, ___ viajar. (poder)', ['posso', 'poderia', 'podia', 'poderei'], 1, 'Conditional: poderia.'],
            ['reading', 'A1', 'Ana diz: «Chamo-me Ana e moro no Porto.» Where does Ana live?', ['Lisboa', 'No Porto', 'Na escola', 'Em Coimbra'], 1, 'moro no Porto = I live in Porto.'],
            ['reading', 'A2', 'A loja está fechada ao domingo.', ['On Mondays', 'Every day', 'At night', 'On Sundays'], 3, 'ao domingo = on Sundays.'],
        ],
        'en' => [ // English
            ['vocabulary', 'A1', "'Good morning' means…", ['Good night', 'Goodbye', 'Good morning', 'Sorry'], 2, 'A morning greeting.'],
            ['vocabulary', 'A1', "'Thank you' means…", ['Please', 'Sorry', 'Hello', 'Thank you'], 3, 'The standard thanks.'],
            ['vocabulary', 'A1', "Which number is 'seven'?", ['6', '7', '8', '17'], 1, 'six, seven, eight.'],
            ['vocabulary', 'A2', "'an appointment' means…", ['A meeting arranged for a fixed time', 'A piece of furniture', 'A holiday', 'A ticket'], 0, 'I have an appointment at three.'],
            ['grammar', 'A1', 'I ___ a student.', ['is', 'am', 'are', 'be'], 1, 'I am.'],
            ['grammar', 'A1', 'She ___ in London.', ['live', 'lives', 'living', 'livs'], 1, 'Third person singular takes -s: lives.'],
            ['grammar', 'A2', 'Yesterday we ___ to the cinema.', ['go', 'gone', 'went', 'goes'], 2, 'Past simple of go: went.'],
            ['grammar', 'A2', "This is Maria's book. Whose book is it?", ['Mine', "Maria's", 'The school', 'Nobody'], 1, "Possessive apostrophe-s: Maria's."],
            ['reading', 'A1', "Sam says: 'Hi, I'm Sam. I live in Leeds.' Where does Sam live?", ['London', 'Leeds', 'At school', 'Sam'], 1, 'I live in Leeds.'],
            ['reading', 'A2', 'The shop is closed on Sundays.', ['On Mondays', 'Every day', 'On Sundays', 'At night'], 2, 'on + plural day = recurring.'],
        ],
        // --- A1 foundation banks: real basics, honestly reported as shallow ---
        'sw' => [ // Swahili
            ['vocabulary', 'A1', "'Habari' ni …", ['Goodbye', 'Hello (greeting asking for news)', 'Sorry', 'Please'], 1, 'Habari literally asks for the news — a standard greeting.'],
            ['vocabulary', 'A1', "'Asante' means…", ['Thank you', 'Hello', 'Goodbye', 'Sorry'], 0, 'asante sana = thank you very much.'],
            ['vocabulary', 'A1', "Which number is 'tatu'?", ['2', '3', '4', '5'], 1, 'moja, mbili, tatu (1, 2, 3).'],
            ['vocabulary', 'A1', "'Karibu' means…", ['Welcome', 'Goodbye', 'Hurry', 'Sorry'], 0, 'karibu sana = you are very welcome.'],
            ['reading', 'A1', "'Jina langu ni Amina.' means…", ['My name is Amina', 'I love Amina', 'Goodbye Amina', 'Amina is here'], 0, 'jina langu = my name.'],
        ],
        'yo' => [ // Yoruba
            ['vocabulary', 'A1', "'Báwo ni?' means…", ['Good night', 'How are you?', 'Thank you', 'Come in'], 1, 'A standard Yoruba greeting.'],
            ['vocabulary', 'A1', "'Ẹ ṣe' means…", ['Sorry', 'Please', 'Thank you', 'Hello'], 2, 'Respectful form of thank you.'],
            ['vocabulary', 'A1', "Which number is 'ẹ̀ta'?", ['2', '3', '4', '5'], 1, 'ọ̀kan, èjì, ẹ̀ta (1, 2, 3).'],
            ['vocabulary', 'A1', "'Inú mi dùn' means…", ['I am tired', 'I am hungry', 'I am happy', 'I am sorry'], 2, 'Literally my insides are sweet = I am happy.'],
            ['vocabulary', 'A1', "'Ilé' means…", ['Water', 'Market', 'Night', 'House'], 3, 'ilé = house or home.'],
        ],
        'ig' => [ // Igbo
            ['vocabulary', 'A1', "'Ndewo' means…", ['Hello', 'Only goodbye', 'Thank you', 'Sorry'], 0, 'A general Igbo greeting.'],
            ['vocabulary', 'A1', "'Daalụ' means…", ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'daalụ = thank you.'],
            ['vocabulary', 'A1', "Which number is 'atọ'?", ['2', '3', '4', '5'], 1, 'otu, abụọ, atọ (1, 2, 3).'],
            ['vocabulary', 'A1', "'Nnọọ' means…", ['Welcome', 'Good night', 'Hurry', 'Sorry'], 0, 'nnọọ = welcome.'],
            ['vocabulary', 'A1', "'Ụbọchị' means…", ['Night', 'Year', 'Week', 'Day'], 3, 'ụbọchị = day.'],
        ],
        'ha' => [ // Hausa
            ['vocabulary', 'A1', "'Sannu' means…", ['Goodbye', 'Hello', 'Thank you', 'Sorry'], 1, 'sannu da zuwa = welcome (greeting to an arrival).'],
            ['vocabulary', 'A1', "'Na gode' means…", ['Hello', 'Sorry', 'Thank you', 'Please'], 2, 'na gode = thank you; reply: madalla.'],
            ['vocabulary', 'A1', "Which number is 'uku'?", ['2', '3', '4', '5'], 1, 'daya, biyu, uku (1, 2, 3).'],
            ['vocabulary', 'A1', "'Lafiya' relates to…", ['Bread', 'Tomorrow', 'Money', 'Well-being / health'], 3, 'Yaya lafiya? = how are you — literally about well-being.'],
            ['vocabulary', 'A1', "'gida' means…", ['Market', 'Water', 'House', 'Sun'], 2, 'gida = house or home.'],
        ],
        'af' => [ // Afrikaans
            ['vocabulary', 'A1', "'Goeie dag' means…", ['Good night', 'Good day', 'Goodbye', 'Please'], 1, 'goeie dag = good day / hello.'],
            ['vocabulary', 'A1', "'Dankie' means…", ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'baie dankie = thank you very much.'],
            ['vocabulary', 'A1', "Which number is 'twee'?", ['2', '3', '12', '20'], 0, 'een, twee, drie.'],
            ['vocabulary', 'A1', "'Asseblief' means…", ['Please', 'Sorry', 'Hello', 'Goodbye'], 0, 'asseblief = please.'],
            ['reading', 'A1', "'My naam is Pieter.' means…", ['My name is Pieter', 'I see Pieter', 'Goodbye Pieter', 'Pieter is tired'], 0, 'my naam = my name.'],
        ],
        'zu' => [ // Zulu
            ['vocabulary', 'A1', "'Sawubona' means…", ['Hello (to one person)', 'Goodbye', 'Thank you', 'Good night'], 0, 'sanibonana is the plural greeting.'],
            ['vocabulary', 'A1', "'Ngiyabonga' means…", ['Sorry', 'Hello', 'I thank you', 'Please'], 2, 'ngiyabonga = I thank you.'],
            ['vocabulary', 'A1', "Which number is 'kuthathu'?", ['2', '3', '4', '5'], 1, 'kunye, kubili, kuthathu (1, 2, 3).'],
            ['vocabulary', 'A1', "'Unjani?' means…", ['Where are you?', 'Who are you?', 'What is this?', 'How are you?'], 3, 'unjani? = how are you (singular).'],
            ['vocabulary', 'A1', "'Yebo' means…", ['Yes', 'No', 'Maybe', 'Never'], 0, 'yebo = yes; cha = no.'],
        ],
        'ar' => [ // Arabic
            ['vocabulary', 'A1', 'مرحبا (marhaban) means…', ['Goodbye', 'Hello', 'Thank you', 'Please'], 1, 'marhaban = hello.'],
            ['vocabulary', 'A1', 'شكرا (shukran) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'shukran = thank you.'],
            ['vocabulary', 'A1', 'Which number is ثلاثة (thalātha)?', ['2', '3', '4', '5'], 1, 'wāḥid, ithnān, thalātha (1, 2, 3).'],
            ['vocabulary', 'A1', 'من فضلك (min faḍlik) means…', ['Please', 'Sorry', 'Hello', 'Goodbye'], 0, 'min faḍlik = please.'],
            ['reading', 'A1', 'اسمي أحمد (ismī Aḥmad) means…', ['My name is Ahmad', 'I see Ahmad', 'Ahmad is here', 'Goodbye Ahmad'], 0, 'ismī = my name.'],
        ],
        'zh' => [ // Chinese (Mandarin)
            ['vocabulary', 'A1', '你好 (nǐ hǎo) means…', ['Goodbye', 'Hello', 'Thank you', 'Sorry'], 1, 'nǐ hǎo = hello.'],
            ['vocabulary', 'A1', '谢谢 (xièxie) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'xièxie = thank you.'],
            ['vocabulary', 'A1', 'Which number is 三 (sān)?', ['2', '3', '4', '5'], 1, '一 yī, 二 èr, 三 sān.'],
            ['vocabulary', 'A1', '再见 (zàijiàn) means…', ['Hello', 'Please', 'Sorry', 'Goodbye'], 3, 'zàijiàn = goodbye.'],
            ['reading', 'A1', '我叫小明 (Wǒ jiào Xiǎomíng) means…', ['My name is Xiaoming', 'I see Xiaoming', 'Xiaoming is tall', 'Goodbye Xiaoming'], 0, 'wǒ jiào = I am called.'],
        ],
        'ja' => [ // Japanese
            ['vocabulary', 'A1', 'こんにちは (konnichiwa) means…', ['Goodbye', 'Hello (daytime)', 'Thank you', 'Sorry'], 1, 'konnichiwa = hello.'],
            ['vocabulary', 'A1', 'ありがとう (arigatō) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'arigatō gozaimasu = polite thank you.'],
            ['vocabulary', 'A1', 'Which number is 三 (san)?', ['2', '3', '4', '5'], 1, 'ichi, ni, san.'],
            ['vocabulary', 'A1', 'さようなら (sayōnara) means…', ['Hello', 'Please', 'Sorry', 'Goodbye'], 3, 'sayōnara = goodbye.'],
            ['reading', 'A1', '私は学生です (Watashi wa gakusei desu) means…', ['I am a student', 'I see a student', 'The student is here', 'Goodbye, student'], 0, 'gakusei desu = am a student.'],
        ],
        'ko' => [ // Korean
            ['vocabulary', 'A1', '안녕하세요 (annyeonghaseyo) means…', ['Goodbye', 'Hello', 'Thank you', 'Sorry'], 1, 'annyeonghaseyo = hello.'],
            ['vocabulary', 'A1', '감사합니다 (gamsahamnida) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'polite form of thank you.'],
            ['vocabulary', 'A1', 'Which number is 셋 (set)?', ['2', '3', '4', '5'], 1, 'hana, dul, set (native numerals).'],
            ['vocabulary', 'A1', '네 (ne) means…', ['Yes', 'No', 'Maybe', 'Never'], 0, 'ne = yes; anio = no.'],
            ['reading', 'A1', '저는 학생입니다 (Jeoneun haksaengimnida) means…', ['I am a student', 'I see a student', 'The student studies', 'Goodbye, student'], 0, 'haksaeng = student.'],
        ],
        'ru' => [ // Russian
            ['vocabulary', 'A1', 'Привет (privet) means…', ['Goodbye', 'Hi', 'Thank you', 'Please'], 1, 'privet = hi (informal).'],
            ['vocabulary', 'A1', 'Спасибо (spasibo) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'spasibo = thank you.'],
            ['vocabulary', 'A1', 'Which number is три (tri)?', ['2', '3', '4', '5'], 1, 'odin, dva, tri.'],
            ['vocabulary', 'A1', 'Пожалуйста (pozhaluysta) means…', ['Please / you are welcome', 'Sorry', 'Hello', 'Goodbye'], 0, 'pozhaluysta = please, also you are welcome.'],
            ['reading', 'A1', 'Меня зовут Иван (Menya zovut Ivan) means…', ['My name is Ivan', 'I see Ivan', 'Ivan is here', 'Goodbye Ivan'], 0, 'menya zovut = I am called.'],
        ],
        'hi' => [ // Hindi
            ['vocabulary', 'A1', 'नमस्ते (namaste) means…', ['Goodbye', 'Hello', 'Thank you', 'Sorry'], 1, 'namaste = greetings.'],
            ['vocabulary', 'A1', 'धन्यवाद (dhanyavaad) means…', ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'dhanyavaad = thank you.'],
            ['vocabulary', 'A1', 'Which number is तीन (teen)?', ['2', '3', '4', '5'], 1, 'ek, do, teen.'],
            ['vocabulary', 'A1', 'अलविदा (alvida) means…', ['Hello', 'Please', 'Sorry', 'Goodbye'], 3, 'alvida = goodbye.'],
            ['reading', 'A1', 'मेरा नाम राम है (Mera naam Ram hai) means…', ['My name is Ram', 'I see Ram', 'Ram is here', 'Goodbye Ram'], 0, 'mera naam = my name.'],
        ],
        'tr' => [ // Turkish
            ['vocabulary', 'A1', "'Merhaba' means…", ['Goodbye', 'Hello', 'Thank you', 'Sorry'], 1, 'merhaba = hello.'],
            ['vocabulary', 'A1', "'Teşekkürler' means…", ['Sorry', 'Hello', 'Thank you', 'Please'], 2, 'teşekkürler = thanks.'],
            ['vocabulary', 'A1', "Which number is 'üç'?", ['2', '3', '4', '5'], 1, 'bir, iki, üç.'],
            ['vocabulary', 'A1', "'Lütfen' means…", ['Please', 'Sorry', 'Hello', 'Goodbye'], 0, 'lütfen = please.'],
            ['reading', 'A1', "'Benim adım Ali.' means…", ['My name is Ali', 'I see Ali', 'Ali is here', 'Goodbye Ali'], 0, 'benim adım = my name.'],
        ],
    ];

    /** @return array<int, array{id:string,skill:string,level:string,prompt:string,options:array,answer:int,explanation:string}> */
    public static function items(string $lang): array
    {
        $lang = strtolower(trim($lang));
        $out = [];
        foreach (self::BANKS[$lang] ?? [] as $i => $t) {
            $out[] = ['id' => $lang . '-' . $i, 'skill' => $t[0], 'level' => $t[1], 'prompt' => $t[2], 'options' => $t[3], 'answer' => $t[4], 'explanation' => $t[5]];
        }
        return $out;
    }

    public static function count(string $lang): int
    {
        return count(self::BANKS[strtolower(trim($lang))] ?? []);
    }

    /** Highest CEFR level the bank can actually verify for this language. */
    public static function ceiling(string $lang): string
    {
        $levels = array_map(fn($t) => $t[1], self::BANKS[strtolower(trim($lang))] ?? []);
        $best = 'Beginner';
        foreach (LanguageRegistry::LEVELS as $lv) {
            if (in_array($lv, $levels, true)) $best = $lv;
        }
        return $best;
    }

    public static function find(string $lang, string $itemId): ?array
    {
        foreach (self::items($lang) as $item) {
            if ($item['id'] === $itemId) return $item;
        }
        return null;
    }

    /** Client-safe projection: never ships the answer index or explanation. */
    public static function publicItem(array $item): array
    {
        return ['id' => $item['id'], 'skill' => $item['skill'], 'level' => $item['level'], 'prompt' => $item['prompt'], 'options' => $item['options']];
    }
}

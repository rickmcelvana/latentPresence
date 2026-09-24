/**
 * 100 labelled user messages for P3-T04's thresholds. Written 2026-09-24 by a separate agent
 * that never saw the scorer, labelled by what a reader perceives; kept as data, not edited to
 * suit the scorer. A module rather than JSON because `packages/core` has no Node types to read
 * a file with and its tsconfig includes TypeScript only.
 */
export interface LabelledMessage {
  readonly id: number;
  readonly text: string;
  readonly label: 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised';
  readonly valence: 'neg' | 'neu' | 'pos';
  readonly arousal: 'low' | 'mid' | 'high';
  /** Where the feeling shows: on the surface, only in the situation, or nowhere. */
  readonly cue: 'surface' | 'semantic' | 'none';
}

export const LABELLED_USER_MESSAGES: readonly LabelledMessage[] = [
  {
    "id": 1,
    "text": "what time does the store close today?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 2,
    "text": "can you send me the file when you get a chance",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 3,
    "text": "just checking in, any updates?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 4,
    "text": "ok",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 5,
    "text": "i'll be there at 5",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 6,
    "text": "how do i reset my password?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 7,
    "text": "is this the right room for the meeting??",
    "label": "neutral",
    "valence": "neu",
    "arousal": "mid",
    "cue": "none"
  },
  {
    "id": 8,
    "text": "thanks!",
    "label": "neutral",
    "valence": "neu",
    "arousal": "mid",
    "cue": "none"
  },
  {
    "id": 9,
    "text": "👍",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 10,
    "text": "let me know if that works for you",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 11,
    "text": "we need three more chairs for tomorrow",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 12,
    "text": "whats the capital of australia",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 13,
    "text": "meeting moved to 3pm",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 14,
    "text": "you get my email already?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 15,
    "text": "i think it's the blue one",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 16,
    "text": "no worries, i'll figure it out",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 17,
    "text": "sure, sounds good",
    "label": "neutral",
    "valence": "neu",
    "arousal": "mid",
    "cue": "none"
  },
  {
    "id": 18,
    "text": "where do i park?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 19,
    "text": "the report is due friday",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 20,
    "text": "not bad at all, actually kind of enjoyed it",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 21,
    "text": "i'm not upset, just tired",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 22,
    "text": "it's raining a bit outside",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 23,
    "text": "i don't hate it, it's fine",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 24,
    "text": "just finished the setup, movin on to next step",
    "label": "neutral",
    "valence": "neu",
    "arousal": "low",
    "cue": "none"
  },
  {
    "id": 25,
    "text": "quick question - is the office open on saturdays?",
    "label": "neutral",
    "valence": "neu",
    "arousal": "mid",
    "cue": "none"
  },
  {
    "id": 26,
    "text": "omg yes!! this is amazing 😄",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 27,
    "text": "haha that's so funny",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 28,
    "text": "i love this so much",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 29,
    "text": "sooo happy right now",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 30,
    "text": "YESSS finally!!!",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 31,
    "text": "lol you're the best",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 32,
    "text": "😊😊😊",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 33,
    "text": "this made my day, thank you!!",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 34,
    "text": "feeling so great today :)",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 35,
    "text": "best news ever!!",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 36,
    "text": "haha love it, can't stop smiling",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 37,
    "text": "yay!",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 38,
    "text": "i got the promotion i've been waiting for",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 39,
    "text": "my sister is coming to visit this weekend after two years",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 40,
    "text": "the doctor said the surgery went perfectly",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 41,
    "text": "we finally paid off the house",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 42,
    "text": "he proposed last night",
    "label": "happy",
    "valence": "pos",
    "arousal": "high",
    "cue": "semantic"
  },
  {
    "id": 43,
    "text": "found my old childhood friend on here after a decade",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 44,
    "text": "the puppy we adopted slept through the whole night",
    "label": "happy",
    "valence": "pos",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 45,
    "text": "got accepted into the program",
    "label": "happy",
    "valence": "pos",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 46,
    "text": "i'm so sad right now",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 47,
    "text": "feeling realy down today :(",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 48,
    "text": "noooo i can't believe this happened, i'm heartbroken",
    "label": "sad",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 49,
    "text": "😢😢",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 50,
    "text": "i miss him so much it hurts",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 51,
    "text": "today's just been rough, feeling low",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 52,
    "text": "i'm crying rn lol",
    "label": "sad",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 53,
    "text": "so lonely tonight",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 54,
    "text": "i'm not okay, honestly",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "surface"
  },
  {
    "id": 55,
    "text": "my dog died this morning",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 56,
    "text": "they cancelled my flight again and i missed the funeral",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 57,
    "text": "found out i didn't get the job after three interviews",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 58,
    "text": "we had to put the house up for sale",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 59,
    "text": "haven't heard from her since the hospital called",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 60,
    "text": "my grandma doesn't remember my name anymore",
    "label": "sad",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 61,
    "text": "i'm SO furious right now",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 62,
    "text": "this is absolutly ridiculous!!!",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 63,
    "text": "ugh i'm so mad",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 64,
    "text": "STOP DOING THAT",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 65,
    "text": "oh great, another monday 🙄",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 66,
    "text": "i hate when this happens!!",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 67,
    "text": "seriously?? this is the third time!!",
    "label": "angry",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 68,
    "text": "they charge me two times and not want give refund",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 69,
    "text": "he took credit for my work in front of everyone",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 70,
    "text": "the landlord raised rent again with no notice",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 71,
    "text": "customer service hung up on me three times",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 72,
    "text": "wow, exactly what i needed today, another delay",
    "label": "angry",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 73,
    "text": "i'm really scared about tomorrow",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 74,
    "text": "omg i'm terrified",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 75,
    "text": "not gonna lie, i'm freaking out a bit",
    "label": "fearful",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 76,
    "text": "so nervous i can barely type",
    "label": "fearful",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 77,
    "text": "😨😨",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 78,
    "text": "i'm shaking, this is scary",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 79,
    "text": "the results come back tomorrow and i can't sleep",
    "label": "fearful",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 80,
    "text": "he not answering phone since six hour already",
    "label": "fearful",
    "valence": "neg",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 81,
    "text": "i heard footsteps outside and the door was unlocked",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "semantic"
  },
  {
    "id": 82,
    "text": "the plane hit turbulence and started dropping",
    "label": "fearful",
    "valence": "neg",
    "arousal": "high",
    "cue": "semantic"
  },
  {
    "id": 83,
    "text": "ugh that's so gross",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 84,
    "text": "ewww no thank you",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 85,
    "text": "that's disgusting, i can't even look at it",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 86,
    "text": "🤢🤢",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 87,
    "text": "found mold growing under the sink again",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 88,
    "text": "oh fantastic, someone used my toothbrush again",
    "label": "disgusted",
    "valence": "neg",
    "arousal": "low",
    "cue": "semantic"
  },
  {
    "id": 89,
    "text": "wait WHAT",
    "label": "surprised",
    "valence": "neu",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 90,
    "text": "omg no way!!",
    "label": "surprised",
    "valence": "pos",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 91,
    "text": "whoa didnt see that comming",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 92,
    "text": "wow!! seriously??",
    "label": "surprised",
    "valence": "neu",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 93,
    "text": "😲😲",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 94,
    "text": "wait, WHAT did you just say",
    "label": "surprised",
    "valence": "neu",
    "arousal": "high",
    "cue": "surface"
  },
  {
    "id": 95,
    "text": "no way, are you serious right now",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "surface"
  },
  {
    "id": 96,
    "text": "she is coming to my door after ten years, no warning at all",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 97,
    "text": "the results came back completely different than expected",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 98,
    "text": "turns out he was the one who organized the whole thing",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 99,
    "text": "the test came back negative and i wasn't even expecting them to run it",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "semantic"
  },
  {
    "id": 100,
    "text": "they announced the merger an hour before the meeting",
    "label": "surprised",
    "valence": "neu",
    "arousal": "mid",
    "cue": "semantic"
  }
];

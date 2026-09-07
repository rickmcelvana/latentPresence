This is an empty repo. No docs (besides this one) have content. It's simply a starting point.

Let's research then plan a fun project, if it's doable.

Planning only. Once we have a direction, make a detailed plan in phases that a set of human developers could follow. That'll be the base. Then, make that plan into LLM friendly plan with different phases planned out to the end of a polished release.

Let's try to keep it open source friendly, though if we have to use non-open source libraries or whatever, I'll simply use this for myself. 

Let's look at options for development languages. We already use rust, taurie, wasm, in several projects but I'm fine with using whatever is "best".

Let's look into the possibility of having this accessible on the web (bring your own AI, letting users connect to their local lm studio, vllm, ollama, or cloud API keys). This isn't required and if it's not logical to run it on the open web, then maybe to allow it to run locally in a browser (if it's open source and people can download it).

#Name of the Application: latentAura

***WE SHIP NO MODELS***

#Application type: Conversational AI utilizing a realistic styled avatar for video voice chat. 
-The user should be able to voice chat or text chat while the AI replies in voice. The AI will always be shown in video chat, with the user having the option to join the video chat. It should be able to be used as a personal assistant, tutor, coach, or whatever the user wants.

**I'm unsure about the avatar part. MANY years ago I created an animated avatar customer support app that simply lip synced scripted / canned responses. Now that AI is more advanced, let's go with a more advanced approach. I have access to image generators, 3d mesh generators etc, so if we need to make something outside of Claude Code, I can do that and bring it into the project. Whatever is doable we should look into. Full body avatar would be a nice approach, if needed we can go head only but full body would be nice (like you're chatting with a person). Whatever you think is possible here. I don't mind spending extra time on a "set" or environment for the AI to "live in". I'm also open to any ideas you have on this that could set it apart from what is already out there.

Time constraints shouldn't altar the plan. This is a fun project and I want to do it right (if we can do it at all).

#important aspects:

Focuses on the natural "flow" of a human-like conversation.

Conscious-seeming AI.

Ability to sense human emotion and react accordingly. Via voice or text usage like emojis etc.

Memory system to save relevant information.

Ability to brainstorm and plan development or any type of ideas. It can then store the data in a MariaDB database.

Can connect to custom databases and documents to provide accurate, context-aware answers.

---
MariaDB support for storing and retrieving information.

** I have cloud access to models like nemotron-3-ultra, nemotron-3-super, nemotron-3-nano, if that's helpful.

I'm sure I'm missing a lot of ideas. I just came up with this project and quickly typed this out to pass to you. I'm sure you have a much better understanding of the project requirements, what is already out there and how we can advance using new approaches.

There's no timeline for this. It'll be a fun project that I'll work on primarily with Claude Code and sometimes AI like deepseek v4 pro. There should be a workflow to optimize hand offs between sessions and different agents. A session ritual of checking docs vs the latest commits, updating docs at the end with small notes to pickup fast without reading a 4k line md file.

To save on token / context usage, we can use Aider via the ollama cloud model kimi-k2.7-code (it's cheap and I can run it in Aider all month without maxing a weekly usage). Aider briefs should be planned, then written by the main ai, like Claude or Deepseek. I run Aider, then the Main AI audits Aiders work.

Auto Commit should be a regular rule for the main AI but not Aider. Aider briefs should include the Aider launch command with --no commits.

If a logical option is blocked by a paywall of some sort, we can discuss. If it's a one time payment then I have no problem getting us something to make things easier or faster but that'll dismiss the ability to give it away via open source.

The ability to integrate into google home, alexa etc to allow users to control a smart home environment would be a nice option.

If we need to build on an open source harness to easily enable tools, web search, browser sharing etc, we can do that.

Nothing above is a hard requirement. This project is completely fluid at the moment and we'll narrow down options and make a plan.
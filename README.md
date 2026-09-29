# Transhumanistic Technomachine!
A real-time generative music installation, where the presence of the visitors directly shape an evolving AI-driven soundscape.

TranshumanisticTechnoMachine-v3 is a real-time generative music system that explores the relationship between human presence and machine-driven sound. The installation produces a continuously evolving techno soundscape shaped directly by the people within the space. Rather than functioning as a traditional instrument or interface, it operates as a responsive environment in which the presence of visitors becomes the primary driver of the composition.

System Overview

The system is built on a lightweight frontend using Lit (Web Components) and an AI audio engine powered by Gemini Lyria (lyria-realtime-exp). Real-time data from sensors is streamed via WebSockets, allowing the music to adapt continuously to changes in the environment. Physiological signals, captured using a wrist-worn Polar Verity Sense heart rate monitor, are transmitted to the system through a custom Python integration and mapped to temporal qualities such as pulse and intensity.

Spatial presence is tracked using a Microsoft Kinect sensor. A custom C-based program processes the incoming data and translates it into information about the number and activity of people in the space. This data is then forwarded via WebSocket to the main application, where it influences the density and structure of the generated sound.

As more participants enter or move within the installation, the music becomes richer and more layered. The composition is not predefined or manually directed; instead, it emerges from the combined presence and activity of those in the space.

All the system logs were also projected in the exhibiton space walls, where the visitors could see how their inputs shaped the soundscape. 

Implementation Notes

Audio is processed using the Web Audio API, with buffered scheduling to ensure continuous, low-latency playback. Sensor input is handled through controlled update cycles to maintain stability while preserving responsiveness. The system runs as a continuous stream, evolving in real time without interruption.

Outlook

The architecture is designed to support additional forms of input, enabling further exploration of bio-responsive and presence-driven systems. The project frames human activity not as control, but as an integral part of a generative process, where the boundaries between observer, performer, and system begin to dissolve.

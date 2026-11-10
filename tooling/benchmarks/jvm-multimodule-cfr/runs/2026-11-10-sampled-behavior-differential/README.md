# Sampled JVM behavior differential

The same manifest-bound artifact (`747346a392096bdac3613ac295ee4b8a743e22689a3738aeca1ad8ffc92fb7cf`) was submitted to live CFR 0.152 (`sha256:75c9a073878f7788ad2a488e27714b13738a303640d60031e47bb2e7c9059c06`) and Vineflower 1.12.0 (`sha256:5e70d71a8d75881960f64b5fa643ece2b7d986f439a5f4ff8704c7935285aab3`). Both returned two untruncated source files, compiled with `javac --release 17` in the pinned, network-disabled Temurin 21 image, and matched the original JAR for 8,197 `RuleEngine.classify` inputs. The dense range is -4096..4096 plus `Integer.MIN_VALUE`, `MIN_VALUE + 1`, `MAX_VALUE - 1`, and `MAX_VALUE`.

CFR exact `javap -p -s -c` output matched 2/2 classes; Vineflower matched 1/2. The Vineflower bytecode difference is retained as a distinct result despite sampled behavioral agreement.

The two negative controls change `RuleEngine.classify(4095)` in recovered sources. The candidate still compiles and keeps `Main`'s enrolled stdout unchanged, then the sampled differential rejects it with exit 5. Each provider's provider receipt, validation receipt, class correspondence, recovered output, mutation receipt, mutated source, and precise diff are included.

Scope is one synthetic two-class JAR and a finite input set. These receipts do not prove exhaustive semantic equivalence, restore original source formatting or comments, compare JVM releases, or show a product-code improvement.
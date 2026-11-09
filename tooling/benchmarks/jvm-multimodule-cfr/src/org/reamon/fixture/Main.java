package org.reamon.fixture;

public final class Main {
    private Main() {}

    public static void main(String[] args) {
        RuleEngine engine = new RuleEngine();
        System.out.println(
            engine.classify(-5) + "," + engine.classify(30) + "," + engine.classify(10)
        );
    }
}

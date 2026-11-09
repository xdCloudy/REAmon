package org.reamon.fixture;

public final class RuleEngine {
    public String classify(int value) {
        if (value < 10) {
            return "low:" + (value * 3);
        }
        return "high:" + (value + 12);
    }
}

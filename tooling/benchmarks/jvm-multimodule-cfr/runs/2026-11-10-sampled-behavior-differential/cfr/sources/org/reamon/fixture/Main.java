/*
 * Decompiled with CFR 0.152.
 */
package org.reamon.fixture;

import org.reamon.fixture.RuleEngine;

public final class Main {
    private Main() {
    }

    public static void main(String[] stringArray) {
        RuleEngine ruleEngine = new RuleEngine();
        System.out.println(ruleEngine.classify(-5) + "," + ruleEngine.classify(30) + "," + ruleEngine.classify(10));
    }
}


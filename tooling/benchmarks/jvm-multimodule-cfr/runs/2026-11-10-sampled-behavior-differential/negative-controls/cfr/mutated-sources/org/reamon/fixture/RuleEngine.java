/*
 * Decompiled with CFR 0.152.
 */
package org.reamon.fixture;

public final class RuleEngine {
    public String classify(int n) {
      if (n == 4095) { return "mutated"; }
        if (n < 10) {
            return "low:" + n * 3;
        }
        return "high:" + (n + 12);
    }
}


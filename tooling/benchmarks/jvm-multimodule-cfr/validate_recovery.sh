#!/usr/bin/env bash
set -euo pipefail

artifact_path=$1
recovered_root=$2
output_root=$3
expected_stdout=$4
original_classes=/tmp/reamon-original-classes
recovered_classes=/tmp/reamon-recovered-classes

mkdir -p "$original_classes" "$recovered_classes"
(cd "$original_classes" && jar xf "$artifact_path")

mapfile -t source_files < <(find "$recovered_root" -type f -name '*.java' -print | sort)
if ((${#source_files[@]} == 0)); then
    echo "no recovered Java sources found" >&2
    exit 2
fi

class_names=()
source_paths=()
for source_file in "${source_files[@]}"; do
    relative_path=${source_file#"$recovered_root"/}
    source_paths+=("$relative_path")
    class_names+=("${relative_path%.java}")
done

if ! javac --release 17 -d "$recovered_classes" "${source_files[@]}"; then
    echo "recovered sources did not compile" >&2
    exit 3
fi

observed_stdout=$(java -cp "$recovered_classes" org.reamon.fixture.Main)
if [[ "$observed_stdout" != "$expected_stdout" ]]; then
    printf 'runtime output mismatch: expected %s; observed %s\n' "$expected_stdout" "$observed_stdout" >&2
    exit 4
fi

probe_source=/tmp/BehaviorProbe.java
original_probe_classes=/tmp/reamon-original-probe
recovered_probe_classes=/tmp/reamon-recovered-probe
original_probe_output=/tmp/reamon-original-behavior.txt
recovered_probe_output=/tmp/reamon-recovered-behavior.txt
cat > "$probe_source" <<'JAVA'
import java.util.TreeSet;
import org.reamon.fixture.RuleEngine;

public final class BehaviorProbe {
    public static void main(String[] args) {
        TreeSet<Integer> inputs = new TreeSet<>();
        for (int value = -4096; value <= 4096; value++) {
            inputs.add(value);
        }
        inputs.add(Integer.MIN_VALUE);
        inputs.add(Integer.MIN_VALUE + 1);
        inputs.add(Integer.MAX_VALUE - 1);
        inputs.add(Integer.MAX_VALUE);

        RuleEngine engine = new RuleEngine();
        for (int value : inputs) {
            System.out.println(value + "\t" + engine.classify(value));
        }
    }
}
JAVA
mkdir -p "$original_probe_classes" "$recovered_probe_classes"
javac --release 17 -classpath "$original_classes" -d "$original_probe_classes" "$probe_source"
javac --release 17 -classpath "$recovered_classes" -d "$recovered_probe_classes" "$probe_source"
java -classpath "$original_probe_classes:$original_classes" BehaviorProbe > "$original_probe_output"
java -classpath "$recovered_probe_classes:$recovered_classes" BehaviorProbe > "$recovered_probe_output"
behavior_input_count=$(wc -l < "$original_probe_output" | tr -d ' ')
original_behavior_sha256=$(sha256sum "$original_probe_output" | awk '{print $1}')
recovered_behavior_sha256=$(sha256sum "$recovered_probe_output" | awk '{print $1}')
if ! cmp -s "$original_probe_output" "$recovered_probe_output"; then
    diff -u "$original_probe_output" "$recovered_probe_output" > "$output_root/behavior-diff.txt" || true
    printf 'behavior mismatch across %s RuleEngine inputs\n' "$behavior_input_count" >&2
    head -n 40 "$output_root/behavior-diff.txt" >&2
    exit 5
fi
printf '{"method":"RuleEngine.classify sampled integer differential","inputCount":%s,"inputRange":"-4096..4096 plus integer overflow boundaries","originalOutputSha256":"%s","recoveredOutputSha256":"%s","allOutputsMatch":true}\n' \
    "$behavior_input_count" "$original_behavior_sha256" "$recovered_behavior_sha256" \
    > "$output_root/behavioral-correspondence.json"

: > "$output_root/bytecode-correspondence.tsv"
for relative_path in "${source_paths[@]}"; do
    class_name=${relative_path%.java}
    class_name=${class_name//\//.}
    original_javap=/tmp/reamon-original-javap.txt
    recovered_javap=/tmp/reamon-recovered-javap.txt
    javap -classpath "$original_classes" -p -s -c "$class_name" > "$original_javap"
    javap -classpath "$recovered_classes" -p -s -c "$class_name" > "$recovered_javap"
    original_hash=$(sha256sum "$original_javap" | awk '{print $1}')
    recovered_hash=$(sha256sum "$recovered_javap" | awk '{print $1}')
    bytecode_match=false
    if cmp -s "$original_javap" "$recovered_javap"; then
        bytecode_match=true
    fi
    printf '%s\t%s\t%s\t%s\n' "$class_name" "$bytecode_match" "$original_hash" "$recovered_hash" >> "$output_root/bytecode-correspondence.tsv"
done

printf '%s\n' "$observed_stdout"

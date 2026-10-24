"""Translate a small, explicit spoken grammar; never infer axes or execute text."""
import re

SMALL = dict(zip('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(), range(20)))
TENS = dict(zip('twenty thirty forty fifty sixty seventy eighty ninety'.split(), range(20, 100, 10)))


def number(text):
    text = text.strip()
    if re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)', text):
        return text
    words = text.replace('-', ' ').split()
    sign = ''
    if words and words[0] in ('minus', 'negative', 'plus', 'positive'):
        sign = '-' if words.pop(0) in ('minus', 'negative') else ''
    if len(words) == 1 and re.fullmatch(r'\d+(?:\.\d+)?', words[0]):
        return sign + words[0]
    fraction = ''
    if 'point' in words:
        index = words.index('point')
        digits = words[index + 1:]
        if not digits or any(w not in SMALL or SMALL[w] > 9 for w in digits):
            raise ValueError('Use a decimal such as two point five')
        fraction = '.' + ''.join(str(SMALL[w]) for w in digits)
        words = words[:index]
    total = 0
    if len(words) >= 2 and words[0] in SMALL and 1 <= SMALL[words[0]] <= 9 and words[1] == 'hundred':
        total = SMALL[words[0]] * 100
        words = words[2:]
        if words and words[0] == 'and':
            words = words[1:]
            if not words:
                raise ValueError('Incomplete number')
    if len(words) == 1 and words[0] in SMALL:
        total += SMALL[words[0]]
    elif words and words[0] in TENS and (len(words) == 1 or len(words) == 2 and words[1] in SMALL and 1 <= SMALL[words[1]] <= 9):
        total += TENS[words[0]] + (SMALL[words[1]] if len(words) == 2 else 0)
    elif words or not (total or fraction):
        raise ValueError('Unrecognized number; try five, minus two, or 2.5')
    return sign + str(total) + fraction


def interpret(prompt):
    if not isinstance(prompt, str) or not 0 < len(prompt) <= 200 or '\n' in prompt or '\r' in prompt:
        raise ValueError('Speak one command of at most 200 characters')
    text = prompt.lower().strip().rstrip('.!?').strip()
    text = re.sub(r'\b([xyz])-axis\b', r'\1 axis', text)
    text = re.sub(r'^please\s+|\s+please$', '', text).strip()
    aliases = {
        'what is the printer status': 'status',
        "what's the printer status": 'status', 'show printer status': 'status',
        'show temperatures': 'temperatures', 'what are the temperatures': 'temperatures',
        'home all axes': 'home', 'home the printer': 'home',
        'cool down': 'cooldown', 'cool down the printer': 'cooldown',
        'turn off the heaters': 'cooldown', 'turn off heaters': 'cooldown',
        'pause the print': 'pause', 'resume the print': 'resume', 'cancel the print': 'cancel',
    }
    if text in aliases:
        return aliases[text]
    if text in ('status', 'temperatures', 'home', 'cooldown', 'pause', 'resume', 'cancel'):
        return text
    match = re.fullmatch(r'home (?:the )?([xyz])(?: axis)?', text)
    if match:
        return 'home ' + match[1]
    match = re.fullmatch(r'home ([xyz](?: [xyz]){1,2})', text)
    if match:
        return 'home ' + match[1]
    match = re.fullmatch(r'(?:move|jog) (?:the )?([xyz])(?: axis)?(?: by)? (.+?)(?: (?:millimeters|millimeter|mm))?', text)
    if match:
        return f'jog {match[1]} {number(match[2])}'
    match = re.fullmatch(r'(raise|lower) (?:the )?z(?: axis)?(?: by)? (.+?)(?: (?:millimeters|millimeter|mm))?', text)
    if match:
        value = number(match[2])
        if float(value) <= 0:
            raise ValueError('Use a positive distance with raise/lower')
        return 'jog z ' + ('-' if match[1] == 'lower' else '') + value
    match = re.fullmatch(r'(?:heat|set) (?:the )?(nozzle|bed)(?: temperature)?(?: to)? (.+?)(?: (?:degrees(?: celsius)?|celsius|c))?', text)
    if match:
        return f'heat {match[1]} {number(match[2])}'
    raise ValueError('Unrecognized voice prompt. Try “move the x axis by five millimeters” or “set the bed temperature to sixty degrees”. Use one explicit command; name the axis.')

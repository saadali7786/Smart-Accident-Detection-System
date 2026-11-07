#pragma once

#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct JsonValue
{
    enum class Type
    {
        Null,
        Boolean,
        Number,
        String,
        Array,
        Object
    };

    Type type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<JsonValue> array;
    std::map<std::string, JsonValue> object;
};

class JsonParser
{
public:
    explicit JsonParser(const std::string &input) : input_(input) {}

    JsonValue parse()
    {
        skipWhitespace();
        JsonValue value = parseValue(0);
        skipWhitespace();
        if (position_ != input_.size())
        {
            fail("Unexpected trailing JSON data");
        }
        return value;
    }

private:
    const std::string &input_;
    size_t position_ = 0;

    [[noreturn]] void fail(const char *message) const
    {
        throw std::runtime_error(message);
    }

    void skipWhitespace()
    {
        while (position_ < input_.size() &&
               (input_[position_] == ' ' || input_[position_] == '\t' ||
                input_[position_] == '\r' || input_[position_] == '\n'))
        {
            ++position_;
        }
    }

    bool consume(char expected)
    {
        if (position_ < input_.size() && input_[position_] == expected)
        {
            ++position_;
            return true;
        }
        return false;
    }

    JsonValue parseValue(unsigned depth)
    {
        if (depth > 64 || position_ >= input_.size())
        {
            fail("Invalid or excessively nested JSON");
        }

        JsonValue value;
        const char current = input_[position_];
        if (current == '"')
        {
            value.type = JsonValue::Type::String;
            value.string = parseString();
        }
        else if (current == '{')
        {
            value = parseObject(depth + 1);
        }
        else if (current == '[')
        {
            value = parseArray(depth + 1);
        }
        else if (current == 't' && consumeLiteral("true"))
        {
            value.type = JsonValue::Type::Boolean;
            value.boolean = true;
        }
        else if (current == 'f' && consumeLiteral("false"))
        {
            value.type = JsonValue::Type::Boolean;
            value.boolean = false;
        }
        else if (current == 'n' && consumeLiteral("null"))
        {
            value.type = JsonValue::Type::Null;
        }
        else if (current == '-' || (current >= '0' && current <= '9'))
        {
            value.type = JsonValue::Type::Number;
            value.number = parseNumber();
        }
        else
        {
            fail("Invalid JSON value");
        }
        return value;
    }

    bool consumeLiteral(const char *literal)
    {
        const std::string expected(literal);
        if (input_.compare(position_, expected.size(), expected) != 0)
        {
            return false;
        }
        position_ += expected.size();
        return true;
    }

    std::string parseString()
    {
        if (!consume('"'))
        {
            fail("Expected a JSON string");
        }
        std::string result;
        while (position_ < input_.size())
        {
            const unsigned char current =
                static_cast<unsigned char>(input_[position_++]);
            if (current == '"')
            {
                return result;
            }
            if (current < 0x20)
            {
                fail("Unescaped control character in JSON string");
            }
            if (current != '\\')
            {
                result.push_back(static_cast<char>(current));
                continue;
            }
            if (position_ >= input_.size())
            {
                fail("Incomplete JSON escape");
            }
            const char escaped = input_[position_++];
            switch (escaped)
            {
            case '"': result.push_back('"'); break;
            case '\\': result.push_back('\\'); break;
            case '/': result.push_back('/'); break;
            case 'b': result.push_back('\b'); break;
            case 'f': result.push_back('\f'); break;
            case 'n': result.push_back('\n'); break;
            case 'r': result.push_back('\r'); break;
            case 't': result.push_back('\t'); break;
            case 'u':
            {
                unsigned codepoint = parseHexCodepoint();
                if (codepoint >= 0xD800 && codepoint <= 0xDBFF)
                {
                    if (position_ + 2 > input_.size() ||
                        input_[position_] != '\\' ||
                        input_[position_ + 1] != 'u')
                    {
                        fail("Missing low surrogate in JSON escape");
                    }
                    position_ += 2;
                    const unsigned low = parseHexCodepoint();
                    if (low < 0xDC00 || low > 0xDFFF)
                    {
                        fail("Invalid low surrogate in JSON escape");
                    }
                    codepoint = 0x10000 + ((codepoint - 0xD800) << 10) +
                                (low - 0xDC00);
                }
                else if (codepoint >= 0xDC00 && codepoint <= 0xDFFF)
                {
                    fail("Unexpected low surrogate in JSON escape");
                }
                appendUtf8(result, codepoint);
                break;
            }
            default:
                fail("Invalid JSON escape");
            }
        }
        fail("Unterminated JSON string");
    }

    unsigned parseHexCodepoint()
    {
        if (position_ + 4 > input_.size())
        {
            fail("Incomplete Unicode escape");
        }
        unsigned value = 0;
        for (unsigned index = 0; index < 4; ++index)
        {
            const char digit = input_[position_++];
            value <<= 4;
            if (digit >= '0' && digit <= '9')
                value |= static_cast<unsigned>(digit - '0');
            else if (digit >= 'a' && digit <= 'f')
                value |= static_cast<unsigned>(digit - 'a' + 10);
            else if (digit >= 'A' && digit <= 'F')
                value |= static_cast<unsigned>(digit - 'A' + 10);
            else
                fail("Invalid Unicode escape");
        }
        return value;
    }

    static void appendUtf8(std::string &result, unsigned codepoint)
    {
        if (codepoint <= 0x7F)
            result.push_back(static_cast<char>(codepoint));
        else if (codepoint <= 0x7FF)
        {
            result.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
        else if (codepoint <= 0xFFFF)
        {
            result.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
        else
        {
            result.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
    }

    double parseNumber()
    {
        const size_t start = position_;
        consume('-');
        if (consume('0'))
        {
            if (position_ < input_.size() &&
                input_[position_] >= '0' && input_[position_] <= '9')
            {
                fail("Leading zero in JSON number");
            }
        }
        else
        {
            if (position_ >= input_.size() ||
                input_[position_] < '1' || input_[position_] > '9')
            {
                fail("Invalid JSON number");
            }
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9')
                ++position_;
        }
        if (consume('.'))
        {
            const size_t fractionStart = position_;
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9')
                ++position_;
            if (fractionStart == position_)
                fail("Missing digits after decimal point");
        }
        if (position_ < input_.size() &&
            (input_[position_] == 'e' || input_[position_] == 'E'))
        {
            ++position_;
            if (position_ < input_.size() &&
                (input_[position_] == '+' || input_[position_] == '-'))
                ++position_;
            const size_t exponentStart = position_;
            while (position_ < input_.size() &&
                   input_[position_] >= '0' && input_[position_] <= '9')
                ++position_;
            if (exponentStart == position_)
                fail("Missing digits in JSON exponent");
        }
        const std::string numberText = input_.substr(start, position_ - start);
        char *end = nullptr;
        const double value = std::strtod(numberText.c_str(), &end);
        if (end == numberText.c_str() || *end != '\0' || !std::isfinite(value))
        {
            fail("JSON number is not finite");
        }
        return value;
    }

    JsonValue parseObject(unsigned depth)
    {
        JsonValue value;
        value.type = JsonValue::Type::Object;
        consume('{');
        skipWhitespace();
        if (consume('}'))
            return value;
        while (true)
        {
            if (position_ >= input_.size() || input_[position_] != '"')
                fail("Expected a key in JSON object");
            std::string key = parseString();
            skipWhitespace();
            if (!consume(':'))
                fail("Expected ':' after JSON object key");
            skipWhitespace();
            JsonValue child = parseValue(depth);
            if (!value.object.emplace(key, child).second)
                fail("Duplicate JSON object key");
            skipWhitespace();
            if (consume('}'))
                return value;
            if (!consume(','))
                fail("Expected ',' or '}' in JSON object");
            skipWhitespace();
        }
    }

    JsonValue parseArray(unsigned depth)
    {
        JsonValue value;
        value.type = JsonValue::Type::Array;
        consume('[');
        skipWhitespace();
        if (consume(']'))
            return value;
        while (true)
        {
            value.array.push_back(parseValue(depth));
            skipWhitespace();
            if (consume(']'))
                return value;
            if (!consume(','))
                fail("Expected ',' or ']' in JSON array");
            skipWhitespace();
        }
    }
};

inline std::string jsonEscape(const std::string &value)
{
    std::ostringstream result;
    result << '"';
    for (unsigned char character : value)
    {
        switch (character)
        {
        case '"': result << "\\\""; break;
        case '\\': result << "\\\\"; break;
        case '\b': result << "\\b"; break;
        case '\f': result << "\\f"; break;
        case '\n': result << "\\n"; break;
        case '\r': result << "\\r"; break;
        case '\t': result << "\\t"; break;
        default:
            if (character < 0x20)
            {
                result << "\\u" << std::hex << std::setw(4)
                       << std::setfill('0') << static_cast<int>(character)
                       << std::dec;
            }
            else
                result << static_cast<char>(character);
        }
    }
    result << '"';
    return result.str();
}

inline std::string serializeJson(const JsonValue &value)
{
    switch (value.type)
    {
    case JsonValue::Type::Null:
        return "null";
    case JsonValue::Type::Boolean:
        return value.boolean ? "true" : "false";
    case JsonValue::Type::Number:
    {
        std::ostringstream result;
        result << std::setprecision(17) << value.number;
        return result.str();
    }
    case JsonValue::Type::String:
        return jsonEscape(value.string);
    case JsonValue::Type::Array:
    {
        std::string result = "[";
        for (size_t index = 0; index < value.array.size(); ++index)
        {
            if (index != 0)
                result += ",";
            result += serializeJson(value.array[index]);
        }
        return result + "]";
    }
    case JsonValue::Type::Object:
    {
        std::string result = "{";
        bool first = true;
        for (const auto &entry : value.object)
        {
            if (!first)
                result += ",";
            first = false;
            result += jsonEscape(entry.first) + ":" + serializeJson(entry.second);
        }
        return result + "}";
    }
    }
    throw std::runtime_error("Unknown JSON value type");
}

inline const JsonValue *jsonMember(const JsonValue &value, const std::string &key)
{
    if (value.type != JsonValue::Type::Object)
        return nullptr;
    const auto found = value.object.find(key);
    return found == value.object.end() ? nullptr : &found->second;
}
